import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  modifierAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { type BookingFacts, mapBooking } from "#shared/accounting/mappers.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import {
  recordAttendeeRefund,
  soleBookingOrder,
} from "#shared/refund-ledger.ts";
import { describeWithEnv } from "#test-utils";

const ATTENDEE = 3;
const BOOKING_AT = "2026-06-21T00:00:00.000Z";

const facts = (overrides: Partial<BookingFacts> = {}): BookingFacts => ({
  amountPaid: 5000,
  attendeeId: ATTENDEE,
  bookingFee: 0,
  currency: "GBP",
  eventId: "sess-1",
  lines: [{ gross: 5000, listingId: 1 }],
  modifiers: [],
  occurredAt: BOOKING_AT,
  ...overrides,
});

const postBooking = async (
  overrides: Partial<BookingFacts> = {},
): Promise<void> => {
  await postTransfers(await mapBooking(facts(overrides)));
};

const refundLegsOf = (legs: Transfer[]): Transfer[] =>
  legs.filter((leg) => (leg.kind ?? "").startsWith("refund_"));

// -- soleBookingOrder (pure) --------------------------------------------- //

const leg = (overrides: Partial<Transfer>): Transfer => ({
  amount: 5000,
  currency: "GBP",
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

describe("refund-ledger > soleBookingOrder", () => {
  test("returns the single booking group's legs", () => {
    const sale = leg({ kind: "sale", reference: "sale" });
    const pay = leg({ kind: "payment", reference: "pay", source: WORLD });
    expect(soleBookingOrder([sale, pay])).toEqual([sale, pay]);
  });

  test("returns a sale-less paid order (surcharge, no sale leg)", () => {
    // A free listing with a paid surcharge: modifier + payment, no sale leg.
    const mod = leg({ kind: "modifier", reference: "mod" });
    const pay = leg({ kind: "payment", reference: "pay", source: WORLD });
    expect(soleBookingOrder([mod, pay])).toEqual([mod, pay]);
  });

  test("returns null for a payment-only group (no recognised revenue)", () => {
    expect(soleBookingOrder([leg({ kind: "payment", source: WORLD })])).toBe(
      null,
    );
  });

  test("returns null for an empty account", () => {
    expect(soleBookingOrder([])).toBe(null);
  });

  test("returns null when a balance settlement accompanies the booking", () => {
    const sale = leg({ eventGroup: "book", kind: "sale", reference: "sale" });
    const deposit = leg({
      eventGroup: "book",
      kind: "payment",
      reference: "dep",
      source: WORLD,
    });
    const balance = leg({
      eventGroup: "bal",
      kind: "payment",
      reference: "bal",
      source: WORLD,
    });
    expect(soleBookingOrder([sale, deposit, balance])).toBe(null);
  });

  test("returns null when two booking orders share the attendee (a merge)", () => {
    const first = leg({ eventGroup: "g1", reference: "s1" });
    const second = leg({ eventGroup: "g2", reference: "s2" });
    expect(soleBookingOrder([first, second])).toBe(null);
  });
});

// -- recordAttendeeRefund (integration) ---------------------------------- //

describeWithEnv("refund-ledger > recordAttendeeRefund", { db: true }, () => {
  test("reverses the booking so revenue and the attendee return to zero", async () => {
    await postBooking({
      amountPaid: 5000,
      lines: [{ gross: 5000, listingId: 1 }],
    });
    await recordAttendeeRefund(ATTENDEE);

    expect(await accountBalance(attendeeAccount(ATTENDEE))).toBe(0);
    expect(await accountBalance(revenueAccount(1))).toBe(0);
    const cash = refundLegsOf(
      await transfersByAccount(attendeeAccount(ATTENDEE)),
    ).filter((l) => l.kind === "refund_cash");
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe(5000);
    expect(cash[0]!.destination).toEqual(WORLD);
  });

  test("reverses a sale-less paid order (surcharge with no sale leg)", async () => {
    await postBooking({
      amountPaid: 500,
      lines: [{ gross: 0, listingId: 1 }],
      modifiers: [{ delta: 500, modifierId: 7 }],
    });
    await recordAttendeeRefund(ATTENDEE);

    expect(await accountBalance(modifierAccount(7))).toBe(0);
    expect(await accountBalance(attendeeAccount(ATTENDEE))).toBe(0);
    const cash = refundLegsOf(
      await transfersByAccount(attendeeAccount(ATTENDEE)),
    ).filter((l) => l.kind === "refund_cash");
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe(500);
  });

  test("skips a balance-settled reservation (booking plus a balance payment)", async () => {
    await postBooking({
      amountPaid: 2000,
      lines: [{ gross: 10000, listingId: 1 }],
    });
    // A later balance settlement posts cash under its own event group.
    await postTransfers([
      {
        amount: 8000,
        currency: "GBP",
        destination: attendeeAccount(ATTENDEE),
        eventGroup: "balance-grp",
        kind: "payment",
        occurredAt: BOOKING_AT,
        reference: "balance-pay",
        source: WORLD,
      },
    ]);
    await recordAttendeeRefund(ATTENDEE);
    expect(
      refundLegsOf(await transfersByAccount(attendeeAccount(ATTENDEE))).length,
    ).toBe(0);
  });

  test("skips a reservation that is not paid in full", async () => {
    // Deposit booking: 2000 paid against a 10000 sale, still owes 8000. A
    // single deposit refund must not reverse the whole sale here.
    await postBooking({
      amountPaid: 2000,
      lines: [{ gross: 10000, listingId: 1 }],
    });
    await recordAttendeeRefund(ATTENDEE);
    expect(
      refundLegsOf(await transfersByAccount(attendeeAccount(ATTENDEE))).length,
    ).toBe(0);
  });

  test("is idempotent — a second refund writes nothing", async () => {
    await postBooking();
    await recordAttendeeRefund(ATTENDEE);
    const afterFirst = (await allTransfers()).length;
    await recordAttendeeRefund(ATTENDEE);
    expect((await allTransfers()).length).toBe(afterFirst);
  });

  test("skips a booking that predates the ledger (no legs to reverse)", async () => {
    await recordAttendeeRefund(ATTENDEE);
    expect((await allTransfers()).length).toBe(0);
  });

  test("skips an attendee carrying more than one booking order", async () => {
    await postBooking({ eventId: "sess-1" });
    await postBooking({ eventId: "sess-2" });
    await recordAttendeeRefund(ATTENDEE);
    expect(
      refundLegsOf(await transfersByAccount(attendeeAccount(ATTENDEE))).length,
    ).toBe(0);
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
        currency: "GBP",
        destination: revenueAccount(99),
        eventGroup: "blocker",
        kind: "sale",
        occurredAt: BOOKING_AT,
        reference: collidingRef,
        source: attendeeAccount(99),
      },
    ]);

    await recordAttendeeRefund(ATTENDEE); // must not throw
    expect(
      refundLegsOf(await transfersByAccount(attendeeAccount(ATTENDEE))).length,
    ).toBe(0);
  });
});
