import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WORLD,
} from "#accounting/accounts.ts";
import {
  type BookingFacts,
  mapBooking,
  mapRefund,
} from "#accounting/mappers.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import {
  asTransfer,
  facts,
  paidBookingNettingToZero,
} from "#test/shared/accounting/mappers/fixtures.ts";
import { rejectionMessage } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("accounting > mapRefund", { encryptionKey: true }, () => {
  const REFUND_AT = "2026-06-22T00:00:00.000Z";

  const bookingOrder = async (
    overrides: Partial<BookingFacts> = {},
  ): Promise<Transfer[]> =>
    (
      await mapBooking(
        facts({
          amountPaid: 5000,
          lines: [{ gross: 5000, listingId: 1 }],
          ...overrides,
        }),
      )
    ).map(asTransfer);

  const refundAndAll = async (
    order: Transfer[],
  ): Promise<{ refund: Transfer[]; all: Transfer[] }> => {
    const refund = (
      await mapRefund({ occurredAt: REFUND_AT, orderLegs: order })
    ).map(asTransfer);
    return { all: [...order, ...refund], refund };
  };

  test("stamps the caller's memo and actor on every refund leg", async () => {
    // The memo (a PII-free reason code) and postedBy are the refund's audit
    // trail; a leg that loses either loses the "why" of the reversal.
    const order = await bookingOrder();
    const refund = await mapRefund({
      memo: "auto_refund:sold_out",
      occurredAt: REFUND_AT,
      orderLegs: order,
      postedBy: "user:5",
    });
    expect(refund.length).toBeGreaterThan(0);
    for (const leg of refund) {
      expect(leg.memo).toBe("auto_refund:sold_out");
      expect(leg.postedBy).toBe("user:5");
    }
    // A memo-less refund omits the field rather than stamping undefined.
    const bare = await mapRefund({ occurredAt: REFUND_AT, orderLegs: order });
    expect(bare.every((leg) => !("memo" in leg))).toBe(true);
  });

  test("reverses every leg so revenue, the attendee and cash return to zero", async () => {
    const order = await bookingOrder(paidBookingNettingToZero);
    const { all } = await refundAndAll(order);
    expect(balanceOf(revenueAccount(1))(all)).toBe(0);
    expect(balanceOf(revenueAccount(2))(all)).toBe(0);
    expect(balanceOf(modifierAccount(10))(all)).toBe(0);
    expect(balanceOf(modifierAccount(11))(all)).toBe(0);
    expect(balanceOf(BOOKING_FEE_INCOME)(all)).toBe(0);
    expect(balanceOf(attendeeAccount(3))(all)).toBe(0);
    expect(balanceOf(WORLD)(all)).toBe(0); // cash in, then back out
  });

  test("cancels a deposit booking: full gross reversed, deposit returned", async () => {
    const order = await bookingOrder({
      amountPaid: 2000,
      lines: [{ gross: 10000, listingId: 1 }],
    });
    const { all, refund } = await refundAndAll(order);
    expect(balanceOf(revenueAccount(1))(all)).toBe(0);
    expect(balanceOf(attendeeAccount(3))(all)).toBe(0); // owes nothing now
    const cash = refund.filter((l) => l.kind === "refund_cash");
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe(2000);
    expect(cash[0]!.source).toEqual(attendeeAccount(3));
    expect(cash[0]!.destination).toEqual(WORLD);
  });

  test("shares one refund event group, distinct from the booking, unique refs", async () => {
    const order = await bookingOrder();
    const refund = await mapRefund({
      occurredAt: REFUND_AT,
      orderLegs: order,
    });
    expect(new Set(refund.map((l) => l.eventGroup)).size).toBe(1);
    expect(refund[0]!.eventGroup).not.toBe(order[0]!.eventGroup);
    expect(new Set(refund.map((l) => l.reference)).size).toBe(refund.length);
  });

  test("is deterministic across calls (idempotent references)", async () => {
    const order = await bookingOrder();
    const first = await mapRefund({
      occurredAt: REFUND_AT,
      orderLegs: order,
    });
    const second = await mapRefund({
      occurredAt: REFUND_AT,
      orderLegs: order,
    });
    expect(first.map((l) => l.reference)).toEqual(
      second.map((l) => l.reference),
    );
  });

  test("names the reversed booking order on every refund leg", async () => {
    // The link the per-order refunded projection joins on: a reversal that
    // cannot name the order it undid would mark the wrong booking refunded.
    const order = await bookingOrder();
    const refund = await mapRefund({
      occurredAt: REFUND_AT,
      orderLegs: order,
    });
    expect(refund.length).toBeGreaterThan(0);
    for (const leg of refund) {
      expect(leg.reversesGroup).toBe(order[0]!.eventGroup);
    }
  });

  test("reverses a one-leg order — an owed booking's lone sale", async () => {
    const order = await bookingOrder({
      amountPaid: 0,
      lines: [{ gross: 10000, listingId: 1 }],
    });
    expect(order.length).toBe(1); // one sale leg, nothing collected

    const refund = await mapRefund({
      occurredAt: REFUND_AT,
      orderLegs: order,
    });

    expect(refund.length).toBe(1);
    expect(refund[0]!.reversesGroup).toBe(order[0]!.eventGroup);
  });

  test("stamps the actor onto every refund leg", async () => {
    const order = await bookingOrder();
    const refund = await mapRefund({
      occurredAt: REFUND_AT,
      orderLegs: order,
      postedBy: "admin-7",
    });
    expect(refund.every((l) => l.postedBy === "admin-7")).toBe(true);
  });

  test("defaults the actor to system only when absent, preserving an explicit one", async () => {
    const order = await bookingOrder();
    const defaulted = await mapRefund({
      occurredAt: REFUND_AT,
      orderLegs: order,
    });
    expect(defaulted.every((l) => l.postedBy === "system")).toBe(true);
    // An explicit actor — even "" — is kept by `?? "system"`, where `|| "system"`
    // would wrongly replace the empty string with the default.
    const empty = await mapRefund({
      occurredAt: REFUND_AT,
      orderLegs: order,
      postedBy: "",
    });
    expect(empty.every((l) => l.postedBy === "")).toBe(true);
  });

  test("prefixes an unrecognised kind and tolerates a missing one", async () => {
    const base: Transfer = {
      amount: 100,
      destination: revenueAccount(1),
      eventGroup: "g",
      id: 1,
      occurredAt: REFUND_AT,
      recordedAt: REFUND_AT,
      reference: "base",
      source: attendeeAccount(3),
    };
    const refund = await mapRefund({
      occurredAt: REFUND_AT,
      orderLegs: [
        { ...base, kind: "adjustment", reference: "a" },
        { ...base, reference: "b" },
      ],
    });
    expect(refund.map((l) => l.kind)).toEqual(["refund_adjustment", "refund_"]);
  });

  test("rejects an empty order", async () => {
    expect(
      await rejectionMessage(
        mapRefund({ occurredAt: REFUND_AT, orderLegs: [] }),
      ),
    ).toContain("no order legs");
  });

  test("rejects legs spanning more than one event group", async () => {
    const a = await bookingOrder({ eventId: "a" });
    const b = await bookingOrder({ eventId: "b" });
    expect(
      await rejectionMessage(
        mapRefund({ occurredAt: REFUND_AT, orderLegs: [...a, ...b] }),
      ),
    ).toContain("more than one event group");
  });
});
