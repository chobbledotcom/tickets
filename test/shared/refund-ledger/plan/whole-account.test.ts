import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  modifierAccount,
  revenueAccount,
  WORLD,
  WRITEOFF,
} from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import { isPaymentOnlyAccount } from "#shared/refund-ledger/plan.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";
import {
  ATTENDEE,
  BOOKING_AT,
  expectRecordedRefundClearsAttendeeAndRevenue,
  expectSingleRefundCash,
  legacyReference,
  postBooking,
  refundCashAmounts,
  refundLegsOf,
  sessionReference,
} from "../helpers.ts";

// -- recordAttendeeRefund (integration) ---------------------------------- //

describeWithEnv("refund-ledger > recordAttendeeRefund", { db: true }, () => {
  const errors = setupErrorSpy();

  const expectRefundNeedsManualAdjustment = async (
    references = [sessionReference("sess-1")],
    review: typeof references = [],
  ): Promise<void> => {
    expect(await recordAttendeeRefund(ATTENDEE, references)).toEqual(
      refundLedgerResult([], references, review),
    );
    expect(
      refundLegsOf(await transfersByAccount(attendeeAccount(ATTENDEE))),
    ).toEqual([]);
  };

  const expectRefundNeedsObligationReview = (): Promise<void> => {
    const reference = sessionReference("sess-1");
    return expectRefundNeedsManualAdjustment([reference], [reference]);
  };

  const postPartPaidBookingWithManualCredit = async ({
    eventGroup,
    kind,
    source,
  }: {
    eventGroup: string;
    kind: string;
    source: AccountRef;
  }): Promise<void> => {
    await postBooking({
      amountPaid: 2000,
      lines: [{ gross: 5000, listingId: 1 }],
    });
    await postTransfers([
      {
        amount: 3000,
        destination: attendeeAccount(ATTENDEE),
        eventGroup,
        kind,
        occurredAt: BOOKING_AT,
        reference: eventGroup,
        source,
      },
    ]);
  };

  test("reverses the booking so revenue and the attendee return to zero", async () => {
    await postBooking({
      amountPaid: 5000,
      lines: [{ gross: 5000, listingId: 1 }],
    });
    await expectRecordedRefundClearsAttendeeAndRevenue();

    const cash = await expectSingleRefundCash(5000);
    expect(cash.destination).toEqual(WORLD);
  });

  test("reverses a many-listing booking in a bounded number of round-trips", async () => {
    // Regression: a booking spanning many listings has one sale leg per listing,
    // so reversing it once issued a read-per-leg interactive transaction that held
    // the write lock open long enough for the primary to abort it
    // ("Transaction timed-out"). The reversal must cost O(1) round-trips — prepared
    // reads then one batch — not O(legs).
    const listingCount = 25;
    const lines = Array.from({ length: listingCount }, (_, i) => ({
      gross: 200,
      listingId: i + 1,
    }));
    await postBooking({ amountPaid: listingCount * 200, lines });

    await runWithQueryLogContext(async () => {
      enableQueryLog();
      const result = await recordAttendeeRefund(ATTENDEE, [
        sessionReference("sess-1"),
      ]);
      expect(result).toEqual(refundLedgerResult([sessionReference("sess-1")]));
      // Distinct round-trip start times: a prepared batch shares one window, while
      // a per-leg interactive transaction would show ~legs distinct round-trips
      // (and trip the transaction guard well before reaching them).
      const roundTrips = new Set(getQueryLog().map((q) => q.startedAtMs)).size;
      expect(roundTrips).toBeLessThanOrEqual(6);
    });
  });

  test("reverses a sale-less paid order (surcharge with no sale leg)", async () => {
    await postBooking({
      amountPaid: 500,
      lines: [{ gross: 0, listingId: 1 }],
      modifiers: [{ delta: 500, modifierId: 7 }],
    });
    await recordAttendeeRefund(ATTENDEE, [sessionReference("sess-1")]);

    expect(
      isPaymentOnlyAccount(await transfersByAccount(attendeeAccount(ATTENDEE))),
    ).toBe(false);
    expect(await accountBalance(modifierAccount(7))).toBe(0);
    expect(await accountBalance(attendeeAccount(ATTENDEE))).toBe(0);
    await expectSingleRefundCash(500);
  });

  test("recognises only a nonempty provider-payment account", async () => {
    expect(isPaymentOnlyAccount([])).toBe(false);
    await postTransfers([
      {
        amount: 500,
        destination: attendeeAccount(ATTENDEE),
        eventGroup: "provider-payment",
        kind: KIND.payment,
        occurredAt: BOOKING_AT,
        reference: "provider-payment",
        source: WORLD,
      },
    ]);

    expect(
      isPaymentOnlyAccount(await transfersByAccount(attendeeAccount(ATTENDEE))),
    ).toBe(true);
  });

  test("reverses a balance-settled reservation as one whole account", async () => {
    await postBooking({
      amountPaid: 2000,
      lines: [{ gross: 10000, listingId: 1 }],
    });
    // A later balance settlement posts cash under its own event group.
    await postTransfers([
      {
        amount: 8000,
        destination: attendeeAccount(ATTENDEE),
        eventGroup: await balanceEventGroup("balance-session"),
        kind: "payment",
        occurredAt: BOOKING_AT,
        reference: "balance-pay",
        source: WORLD,
      },
    ]);
    await expectRecordedRefundClearsAttendeeAndRevenue(ATTENDEE, 1, [
      sessionReference("sess-1"),
      sessionReference("balance-session"),
    ]);
    expect(await refundCashAmounts()).toEqual([2000, 8000]);
  });

  test("reverses an owed booking plus a covered balance payment", async () => {
    await postBooking({
      amountPaid: 0,
      eventId: "owed-booking",
      lines: [{ gross: 5000, listingId: 1 }],
    });
    await postTransfers([
      {
        amount: 5000,
        destination: attendeeAccount(ATTENDEE),
        eventGroup: await balanceEventGroup("owed-balance-session"),
        kind: KIND.payment,
        occurredAt: BOOKING_AT,
        reference: "owed-balance-pay",
        source: WORLD,
      },
    ]);

    await expectRecordedRefundClearsAttendeeAndRevenue(ATTENDEE, 1, [
      sessionReference("owed-balance-session"),
    ]);
    expect(await refundCashAmounts()).toEqual([5000]);
  });

  test("skips a reservation that is not paid in full", async () => {
    // Deposit booking: 2000 paid against a 10000 sale, still owes 8000. A
    // single deposit refund must not reverse the whole sale here.
    await postBooking({
      amountPaid: 2000,
      lines: [{ gross: 10000, listingId: 1 }],
    });
    // A guard-skip reports posted:false: the ledger does NOT record a refund, so
    // the caller must surface it (manual adjustment) rather than let the payment
    // read as refunded.
    await expectRefundNeedsObligationReview();
  });

  test("is idempotent — a second refund writes nothing but still reports posted", async () => {
    await postBooking();
    await recordAttendeeRefund(ATTENDEE, [sessionReference("sess-1")]);
    const afterFirst = (await allTransfers()).length;
    // The refund_cash leg is the durable record, so a re-submit is a no-op
    // success — never a false that would prompt a needless manual adjustment.
    expect(
      await recordAttendeeRefund(ATTENDEE, [sessionReference("sess-1")]),
    ).toEqual(refundLedgerResult([sessionReference("sess-1")]));
    expect((await allTransfers()).length).toBe(afterFirst);
  });

  test("skips a booking that predates the ledger (no legs to reverse)", async () => {
    expect(
      await recordAttendeeRefund(ATTENDEE, [sessionReference("sess-1")]),
    ).toEqual(refundLedgerResult([], [sessionReference("sess-1")]));
    expect((await allTransfers()).length).toBe(0);
  });

  test("reverses an attendee carrying more than one fully-paid booking order", async () => {
    await postBooking({ eventId: "sess-1" });
    await postBooking({ eventId: "sess-2" });
    const references = [sessionReference("sess-1"), sessionReference("sess-2")];
    expect(await recordAttendeeRefund(ATTENDEE, references)).toEqual(
      refundLedgerResult(references),
    );
    expect(await accountBalance(attendeeAccount(ATTENDEE))).toBe(0);
    expect(await refundCashAmounts()).toEqual([5000, 5000]);
  });

  test("lets one legacy payment reference cover one old unmatched payment group", async () => {
    await postBooking({ eventId: "old-pruned-session" });

    await expectRecordedRefundClearsAttendeeAndRevenue(ATTENDEE, 1, [
      legacyReference("pi_legacy"),
    ]);
  });

  test("fails closed when no reference covers the provider payment group", async () => {
    await postBooking({ eventId: "recorded-session" });

    await expectRefundNeedsManualAdjustment([
      sessionReference("different-session"),
    ]);
  });

  test("fails closed when a fully paid account includes manual payment", async () => {
    await postPartPaidBookingWithManualCredit({
      eventGroup: "manual-pay",
      kind: "manual_attendee_payment",
      source: WORLD,
    });

    await expectRefundNeedsObligationReview();
  });

  test("fails closed when a fully paid account includes a write-off correction", async () => {
    await postPartPaidBookingWithManualCredit({
      eventGroup: "manual-writeoff",
      kind: KIND.adjustment,
      source: WRITEOFF,
    });

    await expectRefundNeedsObligationReview();
  });

  test("logs and does not throw when the refund post conflicts", async () => {
    await postBooking();
    const stored = await transfersByAccount(attendeeAccount(ATTENDEE));
    const sale = stored.find((l) => l.kind === "sale")!;
    // Pre-claim one refund leg's reference under a different event, so the refund
    // post hits a reference collision and the catch path runs.
    const collidingRef = await legReference([
      "refund",
      sale.eventGroup,
      sale.reference,
    ]);
    await postTransfers([
      {
        amount: 100,
        destination: revenueAccount(99),
        eventGroup: "blocker",
        kind: "sale",
        occurredAt: BOOKING_AT,
        reference: collidingRef,
        source: attendeeAccount(99),
      },
    ]);

    // Must not throw (the provider refund already committed), but must report
    // posted:false: with the refunded column gone, a swallowed post would leave
    // the payment reading as un-refunded and re-refundable. Fail loudly instead.
    await expectRefundNeedsManualAdjustment();
    // "Logs" is part of the contract: the operator's only breadcrumb for a
    // stranded refund is the classified error.
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
  });
});
