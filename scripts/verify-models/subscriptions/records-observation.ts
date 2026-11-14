/** Stored observations and independent expectations for protected ticket records.
 * Reads retain the actual refused state, including listing totals and ledger legs.
 */
import type { TransferEndpoints } from "#accounting/rows.ts";
import { queryAll, queryAllPrimary } from "#db/client.ts";
import {
  liveBookingOfAttendees,
  liveListingRefusal,
} from "#db/subscriptions.ts";
import {
  liveStatus,
  type RecordFacts,
  recordPlanObservation,
} from "./records-facts.ts";
import type { RecordScenario } from "./records-operations.ts";

export type RecordStageOutcome = {
  accepted: boolean;
  applyRan: boolean;
  validationAccepted: boolean;
  validationUnchanged: boolean;
};
type StoredBooking = {
  id: number;
  attendee_id: number;
  listing_id: number;
  quantity: number;
  subscription_id: string;
  recurring_price: number;
  recurring_tax: number;
  recurring_interval: string;
  subscription_status: string;
};
type RecordBefore = {
  protectedAttendee: number;
  liveRead: boolean;
  listingRefused: boolean;
  snapshot: string;
  money: TransferEndpoints[];
};
const DROPS = [
  "edit-drop",
  "delete",
  "delete-race",
  "merge-drop-source",
  "merge-drop-target",
];
const CONFLICTS = [
  "merge-drop-source",
  "merge-drop-target",
  "merge-take-source",
  "merge-preserve-target",
];

const readMoney = () =>
  queryAll<TransferEndpoints>("SELECT * FROM transfers ORDER BY id");

export const readRecordSnapshot = async () =>
  JSON.stringify(
    await Promise.all([
      queryAll("SELECT * FROM attendees ORDER BY id"),
      queryAll("SELECT * FROM listing_attendees ORDER BY id"),
      queryAll("SELECT * FROM listings ORDER BY id"),
      queryAll(
        "SELECT * FROM attendee_answers ORDER BY attendee_id, question_id",
      ),
      readMoney(),
    ]),
  );

export const readRecordBefore = async (
  protectedAttendee: number,
): Promise<RecordBefore> => ({
  listingRefused: (await liveListingRefusal(11)) !== null,
  liveRead:
    (await queryAllPrimary(liveBookingOfAttendees([protectedAttendee])))
      .length > 0,
  money: await readMoney(),
  protectedAttendee,
  snapshot: await readRecordSnapshot(),
});

const admission = (input: RecordScenario) => {
  const live = input.status !== "" && liveStatus[input.status];
  const dropped = DROPS.includes(input.operation);
  const expectedAccepted =
    input.operation !== "merge-fault" && !(live && dropped);
  return { dropped, expectedAccepted, live };
};

const expectedPlan = (input: RecordScenario) => {
  if (input.status === "")
    return {
      expectedInterval: "",
      expectedPrice: 0,
      expectedStatus: "",
      expectedSubscription: "",
      expectedTax: 0,
    };
  return {
    expectedInterval: "month",
    expectedPrice: 731,
    expectedStatus: input.status,
    expectedSubscription: "sub_protected",
    expectedTax: 113,
  };
};

const expectedRowCount = (input: RecordScenario, accepted: boolean) => {
  if (!accepted) return CONFLICTS.includes(input.operation) ? 4 : 3;
  if (input.operation === "delete") return 1;
  if (input.operation === "edit-drop") return 2;
  return 3;
};

const expectedShape = (input: RecordScenario, protectedAttendee: number) => {
  const { live, dropped, expectedAccepted } = admission(input);
  const moved =
    expectedAccepted &&
    ["merge-move", "merge-take-source"].includes(input.operation);
  return {
    ...expectedPlan(input),
    expectedAccepted,
    expectedAttendee:
      expectedAccepted && input.operation.startsWith("merge")
        ? 2
        : protectedAttendee,
    expectedBooking: moved ? 0 : 1,
    expectedListing: 11,
    expectedPresent: !(expectedAccepted && dropped),
    expectedQuantity:
      input.quantity + (input.operation === "edit-preserve" ? 1 : 0),
    expectedRowCount: expectedRowCount(input, expectedAccepted),
    live,
  };
};

/** A permitted drop can leave the other ordinary conflict row. Its old id
 * distinguishes it from the protected row, even when neither row has a plan.
 */
const protectedRow = (
  rows: StoredBooking[],
  input: RecordScenario,
  attendee: number,
) => {
  const row = rows.find(
    (item) => item.listing_id === 11 && item.attendee_id === attendee,
  );
  if (row === undefined) return;
  const { dropped, expectedAccepted } = admission(input);
  if (expectedAccepted && dropped && row.id !== 1) return;
  return row;
};

const observedPlan = (row: StoredBooking | undefined) => {
  if (row === undefined)
    return {
      afterQuantity: -1,
      afterStatus: "absent",
      attendee: -1,
      booking: -1,
      interval: "absent",
      listing: -1,
      present: false,
      price: -1,
      subscription: "absent",
      tax: -1,
    };
  return {
    ...recordPlanObservation(row),
    afterQuantity: row.quantity,
    afterStatus: row.subscription_status,
    attendee: row.attendee_id,
    booking: row.id,
    listing: row.listing_id,
    present: true,
  };
};

const repointedMoney = (row: TransferEndpoints) => ({
  ...row,
  dest_id:
    row.dest_type === "attendee" && row.dest_id === "1" ? "2" : row.dest_id,
  source_id:
    row.source_type === "attendee" && row.source_id === "1"
      ? "2"
      : row.source_id,
});

/** Expected legs come from the original ledger, with only the specified merge
 * account repoint. Stored after-legs are read independently after the operation.
 */
export const readRecordOutcome = async (
  input: RecordScenario,
  before: RecordBefore,
  stage: RecordStageOutcome,
): Promise<RecordFacts["operations"][number]> => {
  const rows = await queryAll<StoredBooking>(
    "SELECT * FROM listing_attendees ORDER BY id",
  );
  const expected = expectedShape(input, before.protectedAttendee);
  const observed = protectedRow(rows, input, expected.expectedAttendee);
  const afterMoney = await readMoney();
  const expectedMoney =
    expected.expectedAccepted && input.operation.startsWith("merge")
      ? before.money.map(repointedMoney)
      : before.money;
  return {
    ...stage,
    ...expected,
    ...observedPlan(observed),
    attempt: 1,
    listingRefused: before.listingRefused,
    liveRead: before.liveRead,
    moneyCorrect: JSON.stringify(afterMoney) === JSON.stringify(expectedMoney),
    moneyUnchanged: JSON.stringify(afterMoney) === JSON.stringify(before.money),
    operation: input.operation,
    pass: 1,
    quantity: input.quantity,
    recordsUnchanged: before.snapshot === (await readRecordSnapshot()),
    rowCount: rows.length,
    scenario: input.scenario,
    status: input.status,
  };
};
