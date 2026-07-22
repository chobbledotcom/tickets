/* jscpd:ignore-start */

import { identity, mapById } from "#fp";
import { ATTENDEE } from "#shared/accounting/accounts.ts";
import { insertManyStatement } from "#shared/accounting/rows.ts";
import { assertPostable } from "#shared/accounting/store.ts";
import type { CanonicalOrderBooking } from "#shared/booking-lines.ts";
import {
  addCapacityDemand,
  getOrCreateCapacityBucket,
} from "#shared/db/attendees/capacity/checks.ts";
import { dateToStartEnd } from "#shared/db/attendees/capacity/range.ts";
import type { ListingForGroupLookup } from "#shared/db/attendees/capacity/types.ts";
import type { BookingBatchPlan } from "#shared/db/attendees/create-batch.ts";
import { annotateOrderParents } from "#shared/db/attendees/order-parents.ts";
import { encryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import {
  buildBatchCapacitySql,
  type CapacityBucket,
} from "#shared/db/capacity.ts";
import {
  type CheckoutStage,
  claimCheckoutStagePayment,
} from "#shared/db/checkout-stages.ts";
import {
  resultRows,
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import { orderActivityStatements } from "#shared/db/contact-tokens.ts";
import {
  allModifiersInStockCondition,
  usageBatchInsert,
} from "#shared/db/modifier-usage.ts";
import { batchFinalizeStatements } from "#shared/db/payment-finalize.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import type { ContactInfo } from "#shared/types.ts";
/* jscpd:ignore-end */

export type StagedActivationInput = ContactInfo & {
  bookings: CanonicalOrderBooking[];
  paymentId: string;
};

export type StagedActivationPlan = BookingBatchPlan & {
  finalize: NonNullable<BookingBatchPlan["finalize"]>;
};

export type StagedActivationResult =
  | { success: true }
  | {
      reason: "capacity_exceeded" | "sold_out" | "stage_mismatch";
      success: false;
    };

type StoredLine = {
  end_at: string | null;
  listing_id: number;
  package_group_id: number;
  parent_listing_id: number;
  quantity: number;
  start_at: string | null;
};

type GroupMembership = { group_id: number; listing_id: number };

type ActivationLine = {
  endAt: string | null;
  listingId: number;
  packageGroupId: number;
  parentListingId: number;
  quantity: number;
  startAt: string | null;
};

const activationLines = (bookings: CanonicalOrderBooking[]): ActivationLine[] =>
  bookings.map((booking) => ({
    ...dateToStartEnd(booking.date ?? null, booking.durationDays),
    listingId: booking.listingId,
    packageGroupId: booking.packageGroupId ?? 0,
    parentListingId: booking.parentListingId ?? 0,
    quantity: booking.quantity,
  }));

const sameLine = (stored: StoredLine, expected: ActivationLine): boolean =>
  stored.listing_id === expected.listingId &&
  stored.start_at === expected.startAt &&
  stored.end_at === expected.endAt &&
  stored.parent_listing_id === expected.parentListingId &&
  stored.package_group_id === expected.packageGroupId;

const stagedLinesMatch = (
  stored: StoredLine[],
  expected: ActivationLine[],
): boolean =>
  stored.length === expected.length &&
  stored.every((line) => line.quantity === 0) &&
  stored
    .map((line) => expected.findIndex((candidate) => sameLine(line, candidate)))
    .toSorted((left, right) => left - right)
    .every((expectedIndex, storedIndex) => expectedIndex === storedIndex);

const capacityStatement = (
  bookings: CanonicalOrderBooking[],
  listings: ListingForGroupLookup[],
  memberships: GroupMembership[],
): SqlStatement | null => {
  if (bookings.some((booking) => booking.quantity < 0)) {
    return null;
  }
  const listingById = mapById(identity<ListingForGroupLookup>)(listings);
  if (
    listingById.size !==
    new Set(bookings.map((booking) => booking.listingId)).size
  ) {
    return null;
  }
  const listingDemand = new Map<number, CapacityBucket>();
  const groupDemand = new Map<number, CapacityBucket>();
  for (const booking of bookings) {
    const listing = listingById.get(booking.listingId)!;
    addCapacityDemand(
      getOrCreateCapacityBucket(listingDemand, booking.listingId),
      listing,
      booking,
      booking.date,
    );
    for (const membership of memberships) {
      if (membership.listing_id === booking.listingId) {
        addCapacityDemand(
          getOrCreateCapacityBucket(groupDemand, membership.group_id),
          listing,
          booking,
          booking.date,
        );
      }
    }
  }
  return buildBatchCapacitySql(listingDemand, groupDemand);
};

const expectedLineMatch = (booking: string, expected: string): string =>
  `${booking}.listing_id = json_extract(${expected}.value, '$.listingId')
   AND ${booking}.start_at IS json_extract(${expected}.value, '$.startAt')
   AND ${booking}.end_at IS json_extract(${expected}.value, '$.endAt')
   AND ${booking}.parent_listing_id = json_extract(${expected}.value, '$.parentListingId')
   AND ${booking}.package_group_id = json_extract(${expected}.value, '$.packageGroupId')`;

const activateLinesStatement = (
  attendeeId: number,
  lines: ActivationLine[],
): SqlStatement => ({
  args: [JSON.stringify(lines), attendeeId],
  sql: `WITH expected AS (SELECT value FROM json_each(?))
        UPDATE listing_attendees AS booking
           SET quantity = (
             SELECT CAST(json_extract(expected.value, '$.quantity') AS INTEGER)
               FROM expected WHERE ${expectedLineMatch("booking", "expected")}
           )
         WHERE booking.attendee_id = ? AND booking.quantity = 0
           AND EXISTS (
             SELECT 1 FROM expected
              WHERE ${expectedLineMatch("booking", "expected")}
           )`,
});

const attendeeLegs = (
  legs: TransferInput[],
  attendeeId: number,
): TransferInput[] =>
  legs.map((leg) => ({
    ...leg,
    destination:
      leg.destination.type === ATTENDEE
        ? { ...leg.destination, id: String(attendeeId) }
        : leg.destination,
    source:
      leg.source.type === ATTENDEE
        ? { ...leg.source, id: String(attendeeId) }
        : leg.source,
  }));

const claimActivation = async (
  tx: TxScope,
  stage: CheckoutStage,
): Promise<void> => {
  const [stageClaim, paymentClaim] = await claimCheckoutStagePayment(
    tx,
    stage,
    "pending",
  );
  if (stageClaim!.rowsAffected !== 1) {
    throw new Error(
      `Checkout stage ${stage.paymentSessionId} was not pending for attendee ${stage.attendeeId}`,
    );
  }
  if (paymentClaim!.rowsAffected !== 1) {
    throw new Error(
      `Payment session ${stage.paymentSessionId} was not claimed`,
    );
  }
};

const activationRefusal = async (
  tx: TxScope,
  stage: CheckoutStage,
  bookings: CanonicalOrderBooking[],
  lines: ActivationLine[],
  plan: StagedActivationPlan,
): Promise<Exclude<StagedActivationResult, { success: true }> | null> => {
  const listingIds = [...new Set(bookings.map((booking) => booking.listingId))];
  const placeholders = listingIds.map(() => "?").join(", ");
  const [storedResult, listingResult, membershipResult] = await tx.batch([
    {
      args: [stage.attendeeId],
      sql: `SELECT listing_id, start_at, end_at, quantity,
                   parent_listing_id, package_group_id
              FROM listing_attendees WHERE attendee_id = ?`,
    },
    {
      args: listingIds,
      sql: `SELECT id, listing_type FROM listings WHERE id IN (${placeholders})`,
    },
    {
      args: listingIds,
      sql: `SELECT listing_id, group_id FROM group_listings
             WHERE listing_id IN (${placeholders})`,
    },
  ]);
  if (!stagedLinesMatch(resultRows<StoredLine>(storedResult!), lines)) {
    return { reason: "stage_mismatch", success: false };
  }
  const capacity = capacityStatement(
    bookings,
    resultRows<ListingForGroupLookup>(listingResult!),
    resultRows<GroupMembership>(membershipResult!),
  );
  if (!capacity) return { reason: "capacity_exceeded", success: false };
  const stock = allModifiersInStockCondition(plan.usages);
  const [fits, inStock] = await tx.batch([
    capacity,
    { args: stock.args, sql: `SELECT (${stock.sql}) AS available` },
  ]);
  if (Number(resultRows<{ fits: number }>(fits!)[0]!.fits) !== 1) {
    return { reason: "capacity_exceeded", success: false };
  }
  return Number(resultRows<{ available: number }>(inStock!)[0]!.available) === 1
    ? null
    : { reason: "sold_out", success: false };
};

const activationWriteStatements = (
  stage: CheckoutStage,
  lines: ActivationLine[],
  plan: StagedActivationPlan,
  piiUpdate: SqlStatement,
  activity: SqlStatement[],
  finalize: SqlStatement[],
): SqlStatement[] => {
  const legs = attendeeLegs(plan.legs, stage.attendeeId);
  return [
    piiUpdate,
    activateLinesStatement(stage.attendeeId, lines),
    ...(plan.usages.length > 0
      ? [usageBatchInsert(plan.usages, stage.attendeeId)]
      : []),
    ...(legs.length > 0
      ? [
          insertManyStatement(legs, nowIso()),
          {
            args: [legs[0]!.eventGroup, stage.attendeeId],
            sql: `UPDATE listing_attendees SET ledger_event_group = ?
                   WHERE attendee_id = ?`,
          },
        ]
      : []),
    ...activity,
    ...finalize,
    {
      args: [stage.paymentSessionId, stage.attendeeId],
      sql: `DELETE FROM checkout_stages
             WHERE payment_session_id = ? AND attendee_id = ? AND state = 'pending'`,
    },
  ];
};

const writeActivation = async (
  tx: TxScope,
  stage: CheckoutStage,
  statements: SqlStatement[],
): Promise<void> => {
  try {
    await tx.batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("processed_payments.processed_at")
    ) {
      throw new Error(
        `Payment session ${stage.paymentSessionId} was not finalized`,
      );
    }
    throw error;
  }
};

/** Activate one staged attendee and every canonical booking row under one write lock. */
export const activateStagedAttendeeImpl = async (
  stage: CheckoutStage,
  input: StagedActivationInput,
  plan: StagedActivationPlan,
): Promise<StagedActivationResult> => {
  const bookings = await annotateOrderParents(input.bookings);
  const enc = await encryptAttendeeFields(
    {
      ...input,
      paymentId: input.paymentId,
      pricePaid: bookings[0]?.pricePaid ?? 0,
    },
    stage.ticketToken,
  );
  assertPostable(plan.legs);
  const activity = await orderActivityStatements(
    input.email,
    input.phone,
    "public",
    stage.ticketToken,
  );
  const finalize = await batchFinalizeStatements(
    stage.paymentSessionId,
    "?",
    stage.attendeeId,
    plan.finalize.paymentReference,
    stage.ticketToken,
  );
  const lines = activationLines(bookings);
  const statements = activationWriteStatements(
    stage,
    lines,
    plan,
    {
      args: [enc.encryptedPiiBlob, stage.attendeeId],
      sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
    },
    activity,
    finalize,
  );

  return withTransaction(async (tx) => {
    await claimActivation(tx, stage);
    const refusal = await activationRefusal(tx, stage, bookings, lines, plan);
    if (refusal) return refusal;
    await writeActivation(tx, stage, statements);
    return { success: true };
  });
};
