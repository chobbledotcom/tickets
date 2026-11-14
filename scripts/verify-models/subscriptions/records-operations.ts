/** Real edit orchestration, writer-time deletion, and validated merge writes.
 * A booking is a stored ticket line; an attendee can have an extra ordinary line.
 * Merge validation and apply are separate observations. Apply alone has no
 * subscription-loss guard. The caller must validate the same diff and choice.
 */
import { generateKeyPair, importPrivateKey } from "#crypto/hybrid.ts";
import type { DesiredListingLine } from "#db/attendee-types.ts";
import {
  applyAttendeeAtomicEdit,
  loadExistingLines,
} from "#db/attendees/atomic-update.ts";
import { deleteAttendee } from "#db/attendees/delete.ts";
import { attendeePiiWriteStatements } from "#db/attendees/pii-write.ts";
import { executeBatch, type TxScope } from "#db/client.ts";
import {
  loadPaymentMoveSnapshot,
  PaymentRowsBusyError,
} from "#db/payment-admit-move.ts";
import { CONFIG_KEYS, settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  applyAttendeeMerge,
  buildAttendeeMergeDiff,
  conflictBookingEntries,
  validateAttendeeMergeDecision,
} from "#shared/merge/attendee-merge.ts";
import type { AttendeeMergeDecisionInput } from "#shared/merge/attendee-merge-types.ts";
import {
  type SubscriptionPlan,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";
import { seedBooking, withSubscriptionDb } from "./environment.ts";
import type { RecordFacts } from "./records-facts.ts";
import {
  type RecordStageOutcome,
  readRecordBefore,
  readRecordOutcome,
  readRecordSnapshot,
} from "./records-observation.ts";

export const OPERATIONS = [
  "edit-drop",
  "edit-preserve",
  "delete",
  "merge-drop-source",
  "merge-drop-target",
  "merge-move",
  "merge-take-source",
  "merge-preserve-target",
] as const;
type Operation = (typeof OPERATIONS)[number] | "delete-race" | "merge-fault";
export type RecordScenario = {
  scenario: string;
  operation: Operation;
  status: SubscriptionPlan["status"] | "";
  quantity: number;
};
type Keys = { publicKey: string; privateKey: string };

export const recordScenarios = (): RecordScenario[] => [
  ...[...SubscriptionStatusSchema.options, "" as const].flatMap((status) =>
    [0, 1, 3].flatMap((quantity) =>
      OPERATIONS.map((operation) => ({
        operation,
        quantity,
        scenario: `${operation}:${status || "ordinary"}:${quantity}`,
        status,
      })),
    ),
  ),
  {
    operation: "delete-race",
    quantity: 0,
    scenario: "delete-race:active:0",
    status: "active",
  },
  {
    operation: "merge-fault",
    quantity: 1,
    scenario: "merge-fault:active:1",
    status: "active",
  },
];

/* jscpd:ignore-start -- a list of strings, not code */
const pii = {
  address: "",
  email: "",
  lat: "",
  lng: "",
  name: "Model person",
  payment_id: "",
  phone: "",
  special_instructions: "",
  ticket_token: "model-ticket",
};
/* jscpd:ignore-end */
const planFor = (
  status: RecordScenario["status"],
): SubscriptionPlan | undefined =>
  status === ""
    ? undefined
    : { amount: 731, id: "sub_protected", interval: "month", status, tax: 113 };

/** A nonempty two-leg purchase belongs to the ordinary extra line, not to the
 * zero-quantity plan. It makes partial money changes observable on refusal.
 */
const seed = async (input: RecordScenario, keys: Keys) => {
  await settings.setRaw(CONFIG_KEYS.PUBLIC_KEY, keys.publicKey);
  await settings.loadKeys([CONFIG_KEYS.PUBLIC_KEY]);
  const protectedAttendee =
    input.operation === "merge-drop-target" ||
    input.operation === "merge-preserve-target"
      ? 2
      : 1;
  await seedBooking({
    attendeeId: protectedAttendee,
    id: 1,
    listingId: 11,
    plan: planFor(input.status),
    quantity: input.quantity,
  });
  await seedBooking({ attendeeId: 1, id: 2, listingId: 12, quantity: 2 });
  await seedBooking({ attendeeId: 2, id: 3, listingId: 13, quantity: 1 });
  if (
    [
      "merge-drop-source",
      "merge-drop-target",
      "merge-take-source",
      "merge-preserve-target",
    ].includes(input.operation)
  ) {
    await seedBooking({
      attendeeId: protectedAttendee === 1 ? 2 : 1,
      id: 4,
      listingId: 11,
      quantity: input.quantity,
    });
  }
  await executeBatch([
    {
      args: [],
      sql: "UPDATE listing_attendees SET ledger_event_group = CASE WHEN id = 2 THEN 'extra' ELSE 'plan' END",
    },
    {
      args: [],
      sql: "INSERT INTO transfers (id,source_type,source_id,dest_type,dest_id,amount,occurred_at,recorded_at,reference,event_group,kind) VALUES (1,'external','world','attendee','1',47,1,1,'model-cash','extra','payment'),(2,'attendee','1','revenue','12',47,1,1,'model-sale','extra','sale')",
    },
  ]);
  return protectedAttendee;
};

const desiredLine = (
  key: string,
  listingId: number,
  quantity: number,
): DesiredListingLine => ({
  date: null,
  durationDays: 1,
  exists: true,
  key,
  listingId,
  quantity,
});

/** Only the exact subscription refusal can be an ordinary delete outcome. */
const remove = async (): Promise<boolean> => {
  try {
    await deleteAttendee(1);
    return true;
  } catch (error) {
    if (
      !(error instanceof PaymentRowsBusyError) ||
      error.message !== t("error.subscription_live")
    )
      throw error;
    return false;
  }
};

const merge = async (input: RecordScenario, keys: Keys) => {
  const diff = await buildAttendeeMergeDiff(
    {
      sourceBookings: (await loadExistingLines(1)).map((line) => line.booking),
      sourceId: 1,
      sourcePii: pii,
      targetBookings: (await loadExistingLines(2)).map((line) => line.booking),
      targetId: 2,
      targetPii: pii,
    },
    [],
  );
  const takeSource =
    input.operation === "merge-take-source" ||
    input.operation === "merge-drop-target";
  const decision: AttendeeMergeDecisionInput = {
    answers: {},
    bookings: Object.fromEntries(
      conflictBookingEntries(diff).map(({ key }) => [
        key,
        takeSource ? "take_source" : "keep_target",
      ]),
    ),
    money: {},
    pii: {},
    version: diff.version,
  };
  const beforeValidation = await readRecordSnapshot();
  const validation = validateAttendeeMergeDecision(diff, decision);
  const validationUnchanged = beforeValidation === (await readRecordSnapshot());
  if (!validation.valid) {
    const expected = `Listing #11: ${t("error.subscription_live")}`;
    if (validation.errors.length !== 1 || validation.errors[0] !== expected)
      throw new Error(JSON.stringify(validation));
    return {
      accepted: false,
      applyRan: false,
      validationAccepted: false,
      validationUnchanged,
    };
  }
  const fault = new Error("Records model companion write failed");
  try {
    await applyAttendeeMerge({
      decision,
      diff,
      privateKey: await importPrivateKey(keys.privateKey),
      sourceId: 1,
      sourcePii: pii,
      targetId: 2,
      targetPii: pii,
      updateTargetPii: async (tx: TxScope) => {
        await tx.batch(
          await attendeePiiWriteStatements(2, {
            ...pii,
            name: "Merged person",
          }),
        );
        if (input.operation === "merge-fault") throw fault;
      },
    });
    return {
      accepted: true,
      applyRan: true,
      validationAccepted: true,
      validationUnchanged,
    };
  } catch (error) {
    if (error !== fault) throw error;
    return {
      accepted: false,
      applyRan: true,
      validationAccepted: true,
      validationUnchanged,
    };
  }
};

/** A stale admitted preview must not bypass the deletion writer's live guard. */
const prepareDeleteRace = async (input: RecordScenario) => {
  if (input.operation !== "delete-race") return;
  await executeBatch([
    {
      args: [],
      sql: "UPDATE listing_attendees SET subscription_status = 'canceled' WHERE id = 1",
    },
  ]);
  const preview = await loadPaymentMoveSnapshot([1]);
  if (preview.admission.delete.kind !== "available")
    throw new Error("Race preview must permit deletion");
  await executeBatch([
    {
      args: [],
      sql: "UPDATE listing_attendees SET subscription_status = 'active' WHERE id = 1",
    },
  ]);
};

const edit = async (input: RecordScenario) => {
  const existing = await loadExistingLines(1);
  const desired = existing
    .filter(
      (line) =>
        input.operation === "edit-preserve" || line.booking.listing_id !== 11,
    )
    .map((line) =>
      desiredLine(
        line.key,
        line.booking.listing_id,
        line.booking.listing_id === 11
          ? input.quantity + 1
          : line.booking.quantity,
      ),
    );
  const result = await applyAttendeeAtomicEdit(
    1,
    { ...pii, name: "Edited person" },
    desired,
    true,
  );
  if (!result.success && result.reason !== "subscription_live")
    throw new Error(JSON.stringify(result));
  return result.success;
};

const executeOperation = async (
  input: RecordScenario,
  keys: Keys,
): Promise<RecordStageOutcome> => {
  if (input.operation.startsWith("merge")) return merge(input, keys);
  const accepted = input.operation.startsWith("delete")
    ? await remove()
    : await edit(input);
  return {
    accepted,
    applyRan: false,
    validationAccepted: false,
    validationUnchanged: true,
  };
};

/** Optional injection changes persisted results before extraction. It is not a
 * replacement for the operation. Tests use it to expose bad boundary writes.
 */
export const runRecordScenario = async (
  input: RecordScenario,
  beforeExtract?: () => Promise<void>,
  suppliedKeys?: Keys,
): Promise<RecordFacts["operations"][number]> => {
  const keys = suppliedKeys ?? (await generateKeyPair());
  return withSubscriptionDb(async () => {
    const protectedAttendee = await seed(input, keys);
    await prepareDeleteRace(input);
    const before = await readRecordBefore(protectedAttendee);
    const stage = await executeOperation(input, keys);
    if (beforeExtract) await beforeExtract();
    return readRecordOutcome(input, before, stage);
  });
};
