import { afterEach, beforeEach } from "@std/testing/bdd";
import { postWriteoffAdjustmentTx } from "#accounting/adjustments.ts";
import { asOrderLegs, mapBooking, mapRefund } from "#accounting/mappers.ts";
import { transfersByEventGroup } from "#accounting/queries.ts";
import type { RefPart } from "#accounting/refs.ts";
import { postTransfers } from "#accounting/store.ts";
import { getDb, queryOne, withTransaction } from "#db/client.ts";
import { account } from "#shared/ledger/account.ts";
import type { AccountRef, TransferInput } from "#shared/ledger/types.ts";
import { setupTransactionalTestDb } from "#test-utils/db.ts";
import { tx } from "#test-utils/transfer-factory.ts";

/** Post a standalone `writeoff` adjustment in its own transaction — the test-side
 *  convenience over `postWriteoffAdjustmentTx` (production always posts a
 *  correction inside the wider read-then-write transaction that makes it
 *  idempotent, so the bare poster has no production caller). */
export const postWriteoffAdjustment = (
  acct: AccountRef,
  delta: number,
  keyParts: RefPart[],
): Promise<void> =>
  withTransaction((tx) => postWriteoffAdjustmentTx(tx, acct, delta, keyParts));

export { makeTransfer, tx } from "#test-utils/transfer-factory.ts";

/** A sale plus its matching payment for one event (attendee owes nothing after). */
export const saleAndPayment = (): TransferInput[] => [
  tx({ reference: "sale-1", source: account("attendee", 1) }),
  tx({
    destination: account("attendee", 1),
    reference: "pay-1",
    source: account("external", "world"),
  }),
];

/** When a single paid booking's legs were posted. Shared by the sale and the
 *  refund helpers so both describe the same canonical fully-paid booking. */
const BOOKING_OCCURRED_AT = "2026-06-21T00:00:00.000Z";

/** Build the legs of one fully-paid single-listing booking (a `sale` to
 *  `revenue:<listingId>` plus a `payment`), without posting them. */
const oneListingBookingLegs = ({
  listingId,
  attendeeId,
  gross,
  amountPaid = gross,
  eventId,
}: {
  listingId: number;
  attendeeId: number;
  gross: number;
  amountPaid?: number;
  eventId: string;
}): Promise<TransferInput[]> =>
  mapBooking({
    amountPaid,
    attendeeId,
    bookingFee: 0,
    eventId,
    lines: [{ gross, listingId }],
    modifiers: [],
    occurredAt: BOOKING_OCCURRED_AT,
  });

/**
 * Post a fully-paid booking's ledger legs so a `sale` of `gross` lands on
 * `revenue:<listingId>` — which is exactly what a listing's projected income
 * reads (`SUM(amount)` of gross credits to that revenue account). Use this in
 * place of the removed `price_paid`-driven income: a `listing_attendees` row no
 * longer contributes to income on its own. `amountPaid` defaults to `gross`
 * (paid in full, so the attendee account nets to zero). Mirrors production by
 * stamping the booking row's `ledger_event_group`, so the per-row amount-paid
 * projection resolves this sale leg. `stampStartAt` pins the stamp to the row
 * booked for that date — for seeding an attendee who holds SEVERAL orders for
 * one listing (a merge), where each order stamps its own rows. The stamp only
 * fills rows still carrying no order, so a second order never overwrites the
 * first order's link, matching the production writers.
 */
export const postListingSale = async ({
  listingId,
  attendeeId,
  gross,
  amountPaid = gross,
  eventId = `sale-${listingId}-${attendeeId}`,
  stampStartAt,
}: {
  listingId: number;
  attendeeId: number;
  gross: number;
  amountPaid?: number;
  eventId?: string;
  stampStartAt?: string;
  /** @returns the booking event group the sale landed under. */
}): Promise<string> => {
  const legs = await oneListingBookingLegs({
    amountPaid,
    attendeeId,
    eventId,
    gross,
    listingId,
  });
  await postTransfers(legs);
  await getDb().execute({
    args: [
      legs[0]!.eventGroup,
      attendeeId,
      listingId,
      ...(stampStartAt === undefined ? [] : [stampStartAt]),
    ],
    sql:
      "UPDATE listing_attendees SET ledger_event_group = ?" +
      " WHERE attendee_id = ? AND listing_id = ? AND ledger_event_group = ''" +
      (stampStartAt === undefined ? "" : " AND start_at IS ?"),
  });
  return legs[0]!.eventGroup;
};

/**
 * Post a booking whose only money is one modifier leg, so `balanceOf(modifier:M)`
 * — which a modifier's projected `total_revenue` reads directly — reflects that
 * modifier's net effect. `delta` is the modifier's signed amount: positive bills
 * the attendee (a surcharge, attendee→modifier, so the balance rises), negative
 * funds them (a discount, modifier→attendee, so the balance falls). Mirrors
 * production via `mapBooking`, the same path the checkout flow posts through.
 */
export const postModifierLeg = async ({
  modifierId,
  delta,
  attendeeId = 1,
  eventId = `mod-${modifierId}-${attendeeId}`,
}: {
  modifierId: number;
  delta: number;
  attendeeId?: number;
  eventId?: string;
}): Promise<void> => {
  const legs = await mapBooking({
    amountPaid: 0,
    attendeeId,
    bookingFee: 0,
    eventId,
    lines: [],
    modifiers: [{ delta, modifierId }],
    occurredAt: BOOKING_OCCURRED_AT,
  });
  await postTransfers(legs);
};

/**
 * Make an attendee read "refunded" by reversing the booking order their row is
 * stamped with — the production shape: the reversal names that order in
 * `reverses_group`, and the per-order projections resolve it. Throws when the
 * row carries no order yet (a pre-ledger booking — use
 * {@link postAttendeeRefund} to post a self-contained round-trip instead).
 */
export const refundBookedOrder = async (
  attendeeId: number,
  listingId: number,
): Promise<void> => {
  const stamped = await queryOne<{ ledger_event_group: string }>(
    "SELECT ledger_event_group FROM listing_attendees WHERE attendee_id = ?" +
      " AND listing_id = ? AND ledger_event_group != '' ORDER BY id LIMIT 1",
    [attendeeId, listingId],
  );
  if (stamped === null) {
    throw new Error(
      `Attendee ${attendeeId} has no booked order on listing ${listingId} to refund`,
    );
  }
  await postTransfers(
    await mapRefund({
      occurredAt: BOOKING_OCCURRED_AT,
      orderLegs: await transfersByEventGroup(stamped.ledger_event_group),
    }),
  );
};

/**
 * Post a self-contained net-zero refunded booking order — a `sale` + `payment`
 * under one event group, then the full reversal (`refund_sale` + a
 * `refund_cash` leg whose SOURCE is the attendee) — and stamp the booking row
 * with that event group when the row carries no order, so the refunded-status
 * projection resolves it. Use this for an attendee whose own order legs are
 * not under test (a pre-ledger booking, or a deliberate extra order beside a
 * real one); use {@link refundBookedOrder} to refund the order a row really
 * belongs to. Never collides with a booking the attendee may already hold,
 * and nets to zero for both the attendee and revenue (income and balance are
 * left unchanged). Defaults `gross` to 500, matching the paid-test attendee
 * helpers.
 */
export const postAttendeeRefund = async ({
  attendeeId,
  listingId,
  gross = 500,
  eventId = `refund-${listingId}-${attendeeId}`,
}: {
  attendeeId: number;
  listingId: number;
  gross?: number;
  eventId?: string;
}): Promise<void> => {
  const bookingInputs = await oneListingBookingLegs({
    attendeeId,
    eventId,
    gross,
    listingId,
  });
  await postTransfers(bookingInputs);
  await getDb().execute({
    args: [bookingInputs[0]!.eventGroup, attendeeId, listingId],
    sql:
      "UPDATE listing_attendees SET ledger_event_group = ?" +
      " WHERE attendee_id = ? AND listing_id = ? AND ledger_event_group = ''",
  });
  await postTransfers(
    await mapRefund({
      occurredAt: BOOKING_OCCURRED_AT,
      orderLegs: asOrderLegs(bookingInputs, BOOKING_OCCURRED_AT),
    }),
  );
};

/** Run a promise expected to reject and return the thrown error. */
export const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
};

/** Give each test in the current suite a fresh transactional test database. */
export const useTransactionalDb = (): void => {
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    cleanup = await setupTransactionalTestDb();
  });
  afterEach(async () => {
    await cleanup();
  });
};
