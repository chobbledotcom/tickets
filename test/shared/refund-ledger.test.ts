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
import { decrypt } from "#shared/crypto/encryption.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { getNoteRows } from "#shared/db/system-notes.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import {
  recordAttendeeRefund,
  recordPlaceholderRefund,
} from "#shared/refund-ledger.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
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
} from "./refund-ledger/helpers.ts";

// -- recordAttendeeRefund (integration) ---------------------------------- //

describeWithEnv("refund-ledger > recordAttendeeRefund", { db: true }, () => {
  const errors = setupErrorSpy();

  const expectRefundNeedsManualAdjustment = async (
    references = [sessionReference("sess-1")],
  ): Promise<void> => {
    expect(await recordAttendeeRefund(ATTENDEE, references)).toEqual({
      posted: false,
    });
    expect(
      refundLegsOf(await transfersByAccount(attendeeAccount(ATTENDEE))),
    ).toEqual([]);
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
      expect(result).toEqual({ posted: true });
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

    expect(await accountBalance(modifierAccount(7))).toBe(0);
    expect(await accountBalance(attendeeAccount(ATTENDEE))).toBe(0);
    await expectSingleRefundCash(500);
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
    await expectRefundNeedsManualAdjustment();
    // And the miss is logged (Sentry/ntfy/activity log), naming the attendee —
    // never only a dismissible flash. This is the money-integrity contract.
    expect(errors.contains("E_REFUND_NOT_RECORDED")).toBe(true);
    expect(errors.contains(`attendee=${ATTENDEE}`)).toBe(true);
    // The detail names the one stranded account in its singular form
    // ("attendee N", never the plural "attendees N", and the id itself), so a
    // single miss reads unambiguously in the operator-facing activity-log row.
    expect(errors.contains(`record it for attendee ${ATTENDEE} —`)).toBe(true);
    // It also drops a system note on the attendee's own record, so the operator
    // sees the miss where they manage the booking — not only in the error log.
    // The note is PII-free and links the ledger for the manual adjustment.
    const notes = await getNoteRows([ATTENDEE]);
    expect(notes.length).toBe(1);
    const note = notes[0]!;
    if (note.type !== "system") {
      throw new Error(`expected a system note, got ${note.type}`);
    }
    const noteText = await decrypt(note.note);
    expect(noteText).toContain("the ledger did not record it");
    expect(noteText).toContain(`/admin/ledger/attendee/${ATTENDEE}`);
  });

  test("is idempotent — a second refund writes nothing but still reports posted", async () => {
    await postBooking();
    await recordAttendeeRefund(ATTENDEE, [sessionReference("sess-1")]);
    const afterFirst = (await allTransfers()).length;
    // The refund_cash leg is the durable record, so a re-submit is a no-op
    // success — never a false that would prompt a needless manual adjustment.
    expect(
      await recordAttendeeRefund(ATTENDEE, [sessionReference("sess-1")]),
    ).toEqual({ posted: true });
    expect((await allTransfers()).length).toBe(afterFirst);
    // A recorded (or idempotent no-op) refund is not stranded — it must NOT alert.
    expect(errors.contains("E_REFUND_NOT_RECORDED")).toBe(false);
  });

  test("skips a booking that predates the ledger (no legs to reverse)", async () => {
    expect(
      await recordAttendeeRefund(ATTENDEE, [sessionReference("sess-1")]),
    ).toEqual({ posted: false });
    expect((await allTransfers()).length).toBe(0);
    // Even a no-legs skip is a stranded provider refund — it must be logged.
    expect(errors.contains("E_REFUND_NOT_RECORDED")).toBe(true);
  });

  test("reverses an attendee carrying more than one fully-paid booking order", async () => {
    await postBooking({ eventId: "sess-1" });
    await postBooking({ eventId: "sess-2" });
    expect(
      await recordAttendeeRefund(ATTENDEE, [
        sessionReference("sess-1"),
        sessionReference("sess-2"),
      ]),
    ).toEqual({ posted: true });
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

    await expectRefundNeedsManualAdjustment();
  });

  test("fails closed when a fully paid account includes a write-off correction", async () => {
    await postPartPaidBookingWithManualCredit({
      eventGroup: "manual-writeoff",
      kind: KIND.adjustment,
      source: WRITEOFF,
    });

    await expectRefundNeedsManualAdjustment();
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
    // stranded refund is the classified error. A thrown write is a LEDGER_POST
    // (with its stack), NOT a guard-skip — the two classifications stay disjoint.
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
    expect(errors.contains("E_REFUND_NOT_RECORDED")).toBe(false);
    // The breadcrumb names the attendee so the operator knows which account.
    expect(errors.lastMessage()).toContain(`attendee=${ATTENDEE}`);
  });
});

// -- recordPlaceholderRefund (cash round-trip, no sale leg) -------------- //

describeWithEnv("refund-ledger > recordPlaceholderRefund", { db: true }, () => {
  const errors = setupErrorSpy();
  const PH = {
    amount: 5000,
    attendeeId: 7,
    eventId: "ph-sess-1",
    listingId: 1,
    occurredAt: BOOKING_AT,
  };

  test("records the cash round-trip with no sale leg, netting to zero", async () => {
    expect(await recordPlaceholderRefund(PH, "price_changed", true)).toEqual({
      posted: true,
    });
    const legs = await transfersByAccount(attendeeAccount(7));
    // No revenue recognised — just the payment we received and the refund_cash
    // returning it (stamped with the reason), so the line's price_paid stays 0.
    expect(legs.some((l) => l.kind === "sale")).toBe(false);
    expect(legs.some((l) => l.kind === "payment")).toBe(true);
    const cash = legs.filter((l) => l.kind === "refund_cash");
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe(5000);
    expect(cash[0]!.memo).toBe("price_changed");
    expect(balanceOf(attendeeAccount(7))(legs)).toBe(0);
  });

  test("posts only the payment when the refund failed (we still hold the money)", async () => {
    expect(await recordPlaceholderRefund(PH, "charge_mismatch", false)).toEqual(
      {
        posted: false,
      },
    );
    const legs = await transfersByAccount(attendeeAccount(7));
    expect(legs.some((l) => l.kind === "payment")).toBe(true);
    expect(legs.some((l) => l.kind === "refund_cash")).toBe(false);
    // The ledger shows we hold their cash until a manual refund reverses it.
    expect(balanceOf(attendeeAccount(7))(legs)).toBe(5000);
  });

  test("logs and does not throw when the ledger post conflicts", async () => {
    // Pre-claim the payment leg's reference under a different event so the cash-in
    // post hits a reference collision and the catch path runs.
    const collidingRef = await legReference(["booking", PH.eventId, "payment"]);
    await postTransfers([
      {
        amount: 100,
        destination: attendeeAccount(99),
        eventGroup: "blocker",
        kind: "payment",
        occurredAt: BOOKING_AT,
        reference: collidingRef,
        source: WORLD,
      },
    ]);
    expect(await recordPlaceholderRefund(PH, "sold_out", true)).toEqual({
      posted: false,
    });
    // The classified error is the operator's only breadcrumb for the miss, and
    // it names the attendee whose placeholder refund went unrecorded.
    expect(errors.lastMessage()).toContain("E_LEDGER_POST");
    expect(errors.lastMessage()).toContain(`attendee=${PH.attendeeId}`);
  });
});
