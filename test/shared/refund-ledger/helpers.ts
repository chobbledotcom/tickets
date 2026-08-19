import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { attendeeAccount, revenueAccount } from "#accounting/accounts.ts";
import { type BookingFacts, mapBooking } from "#accounting/mappers.ts";
import { accountBalance, transfersByAccount } from "#accounting/queries.ts";
import { postTransfers } from "#accounting/store.ts";
import { getDb, setDb } from "#db/client.ts";
import type { RefundPaymentReference } from "#db/payment-references.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import { refundReference } from "#test-utils/payment-state.ts";
import { statementSql } from "#test-utils/record-queries.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";

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
export const returnedReference = (
  reference: string,
  sessionIds: readonly [string, ...string[]],
): RefundPaymentReference =>
  refundReference(reference, {
    refundState: "completed",
    rowSessionIds: sessionIds,
    sessionIds,
  });

export const sessionReference = (sessionId: string): RefundPaymentReference =>
  returnedReference(`pi-${sessionId}`, [sessionId]);

export const legacyReference = (reference: string): RefundPaymentReference =>
  refundReference(reference, {
    refundState: "completed",
    rowSessionIds: [`legacy:test:${reference}`],
    sessionIds: [],
  });

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

export const readsTransfers = (sql: string): boolean =>
  sql.includes("FROM transfers");

/** Matches the plain and the `OR IGNORE` insert alike. */
export const writesTransfers = (sql: string): boolean =>
  sql.includes("INTO transfers");

/** Run `work` with one kind of ledger statement broken. Reading and writing both
 *  travel as batches, so which one breaks is decided by the statement itself. */
export const withBrokenLedger = async <T>(
  broken: (sql: string) => boolean,
  message: string,
  work: () => Promise<T>,
): Promise<T> => {
  const real = getDb();
  setDb(
    proxyMembers(real, {
      batch: (statements: InStatement[], mode?: "write" | "read") =>
        statements.map(statementSql).some(broken)
          ? Promise.reject(new Error(message))
          : real.batch(statements, mode),
    }),
  );
  try {
    return await work();
  } finally {
    setDb(real);
  }
};

export const expectRecordedRefundClearsAttendeeAndRevenue = async (
  attendeeId = ATTENDEE,
  listingId = 1,
  references: readonly RefundPaymentReference[] = [sessionReference("sess-1")],
): Promise<void> => {
  expect(await recordAttendeeRefund(attendeeId, references)).toEqual(
    refundLedgerResult(references),
  );
  expect(await accountBalance(attendeeAccount(attendeeId))).toBe(0);
  expect(await accountBalance(revenueAccount(listingId))).toBe(0);
};
