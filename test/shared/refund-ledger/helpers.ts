import { expect } from "@std/expect";
import {
  attendeeAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import { type BookingFacts, mapBooking } from "#shared/accounting/mappers.ts";
import {
  accountBalance,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
import { refundReference } from "#test-utils/payment-state.ts";

export const ATTENDEE = 3;
export const BOOKING_AT = "2026-06-21T00:00:00.000Z";

export const facts = (overrides: Partial<BookingFacts> = {}): BookingFacts => ({
  amountPaid: 5000,
  attendeeId: ATTENDEE,
  bookingFee: 0,
  eventId: "sess-1",
  lines: [{ gross: 5000, listingId: 1 }],
  modifiers: [],
  occurredAt: BOOKING_AT,
  ...overrides,
});

export const postBooking = async (
  overrides: Partial<BookingFacts> = {},
): Promise<void> => {
  await postTransfers(await mapBooking(facts(overrides)));
};

/** A reference the provider has already returned, on the rows it names. */
const returnedReference = (
  reference: string,
  sessionIds: readonly string[],
): RefundPaymentReference =>
  refundReference(reference, {
    refundState: "completed",
    rowSessionIds: sessionIds,
    sessionIds,
  });

export const sessionReference = (sessionId: string): RefundPaymentReference =>
  returnedReference(`pi-${sessionId}`, [sessionId]);

export const legacyReference = (reference: string): RefundPaymentReference =>
  returnedReference(reference, []);

export const refundTarget = (
  attendeeId: number,
  sessionId: string,
): { attendeeId: number; references: RefundPaymentReference[] } => ({
  attendeeId,
  references: [sessionReference(sessionId)],
});

export const refundLegsOf = (legs: Transfer[]): Transfer[] =>
  legs.filter((leg) => leg.kind?.startsWith("refund_"));

export const expectSingleRefundCash = async (
  amount: number,
): Promise<Transfer> => {
  const cash = refundLegsOf(
    await transfersByAccount(attendeeAccount(ATTENDEE)),
  ).filter((leg) => leg.kind === "refund_cash");
  expect(cash.length).toBe(1);
  expect(cash[0]!.amount).toBe(amount);
  return cash[0]!;
};

export const refundCashAmounts = async (
  attendeeId = ATTENDEE,
): Promise<number[]> =>
  refundLegsOf(await transfersByAccount(attendeeAccount(attendeeId)))
    .filter((leg) => leg.kind === "refund_cash")
    .map((leg) => leg.amount)
    .sort((a, b) => a - b);

export const expectRecordedRefundClearsAttendeeAndRevenue = async (
  attendeeId = ATTENDEE,
  listingId = 1,
  references: readonly RefundPaymentReference[] = [sessionReference("sess-1")],
): Promise<void> => {
  expect(await recordAttendeeRefund(attendeeId, references)).toEqual({
    posted: true,
  });
  expect(await accountBalance(attendeeAccount(attendeeId))).toBe(0);
  expect(await accountBalance(revenueAccount(listingId))).toBe(0);
};

export const leg = (overrides: Partial<Transfer>): Transfer => ({
  amount: 5000,
  destination: revenueAccount(1),
  eventGroup: "g1",
  id: 1,
  kind: "sale",
  occurredAt: BOOKING_AT,
  recordedAt: BOOKING_AT,
  reference: "r1",
  source: attendeeAccount(ATTENDEE),
  ...overrides,
});
