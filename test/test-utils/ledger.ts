import { afterEach, beforeEach } from "@std/testing/bdd";
import { mapBooking, mapRefund } from "#shared/accounting/mappers.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { setupTransactionalTestDb } from "#test-utils";

/** A {@link TransferInput} with sensible defaults; override any field. */
export const tx = (overrides: Partial<TransferInput> = {}): TransferInput => ({
  amount: 5000,
  currency: "GBP",
  destination: account("revenue", 1),
  eventGroup: "evt-1",
  occurredAt: "2026-06-21T00:00:00.000Z",
  reference: "ref-default",
  source: account("attendee", 1),
  ...overrides,
});

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
    currency: "GBP",
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
 * (paid in full, so the attendee account nets to zero).
 */
export const postListingSale = async ({
  listingId,
  attendeeId,
  gross,
  amountPaid = gross,
  eventId = `sale-${listingId}-${attendeeId}`,
}: {
  listingId: number;
  attendeeId: number;
  gross: number;
  amountPaid?: number;
  eventId?: string;
}): Promise<void> => {
  await postTransfers(
    await oneListingBookingLegs({
      amountPaid,
      attendeeId,
      eventId,
      gross,
      listingId,
    }),
  );
};

/**
 * Make an attendee "refunded" the way production now models it: post a complete,
 * net-zero refunded booking order for them — a `sale` + `payment`, then the full
 * reversal (`refund_sale` + a `refund_cash` leg whose SOURCE is the attendee).
 * The refunded-status projection reads exactly that `refund_cash` leg, so this is
 * the real path that replaces the dropped `refunded` column. Self-contained under
 * its own event group, so it never collides with a booking the attendee may
 * already hold, and nets to zero for both the attendee and revenue (income and
 * balance are left unchanged). Defaults `gross` to 500, matching the paid-test
 * attendee helpers.
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
  // mapRefund reads only money-identity fields (never id/recordedAt), so stamp
  // the just-built inputs into Transfer shape to reverse them — mirroring the
  // historical backfill's full-order reversal.
  const orderLegs: Transfer[] = bookingInputs.map((leg) => ({
    ...leg,
    id: 0,
    recordedAt: BOOKING_OCCURRED_AT,
  }));
  await postTransfers(
    await mapRefund({ occurredAt: BOOKING_OCCURRED_AT, orderLegs }),
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
