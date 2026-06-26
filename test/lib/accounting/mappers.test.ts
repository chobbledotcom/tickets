import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import {
  type BookingFacts,
  mapBooking,
  mapRefund,
} from "#shared/accounting/mappers.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { describeWithEnv, rejectionMessage } from "#test-utils";

// balanceOf ignores id, so a constant id keeps these as plain value assertions.
const asTransfer = (t: TransferInput): Transfer => ({
  ...t,
  id: 0,
  recordedAt: "2026-06-21T00:00:00.000Z",
});

const facts = (overrides: Partial<BookingFacts> = {}): BookingFacts => ({
  amountPaid: 0,
  attendeeId: 3,
  bookingFee: 0,
  eventId: "evt",
  lines: [],
  modifiers: [],
  occurredAt: "2026-06-21T00:00:00.000Z",
  ...overrides,
});

describeWithEnv("accounting > mappers", { encryptionKey: true }, () => {
  describe("mapBooking", () => {
    test("books gross, modifiers, fee and payment; a paid booking nets to zero", async () => {
      const legs = (
        await mapBooking(
          facts({
            amountPaid: 7850,
            bookingFee: 150,
            lines: [
              { gross: 5000, listingId: 1 },
              { gross: 3000, listingId: 2 },
            ],
            modifiers: [
              { delta: -500, modifierId: 10 }, // discount
              { delta: 200, modifierId: 11 }, // surcharge
            ],
          }),
        )
      ).map(asTransfer);

      // 8000 gross + 200 surcharge + 150 fee − 500 discount − 7850 paid = 0
      expect(balanceOf(attendeeAccount(3))(legs)).toBe(0);
      expect(balanceOf(revenueAccount(1))(legs)).toBe(5000);
      expect(balanceOf(revenueAccount(2))(legs)).toBe(3000);
      expect(balanceOf(modifierAccount(10))(legs)).toBe(-500); // contra (discount)
      expect(balanceOf(modifierAccount(11))(legs)).toBe(200); // surcharge revenue
      expect(balanceOf(BOOKING_FEE_INCOME)(legs)).toBe(150);
      expect(balanceOf(WORLD)(legs)).toBe(-7850);
    });

    test("posts a surcharge as a positive attendee→modifier leg, a discount the other way", async () => {
      // balanceOf can't tell the two branches apart — flipping the ends and
      // negating the amount nets the same — so assert the leg's direction and its
      // positive amount directly.
      const [surcharge] = (
        await mapBooking(facts({ modifiers: [{ delta: 200, modifierId: 11 }] }))
      ).filter((l) => l.kind === "modifier");
      expect(surcharge!.amount).toBe(200);
      expect(surcharge!.source).toEqual(attendeeAccount(3));
      expect(surcharge!.destination).toEqual(modifierAccount(11));

      const [discount] = (
        await mapBooking(
          facts({ modifiers: [{ delta: -500, modifierId: 10 }] }),
        )
      ).filter((l) => l.kind === "modifier");
      expect(discount!.amount).toBe(500);
      expect(discount!.source).toEqual(modifierAccount(10));
      expect(discount!.destination).toEqual(attendeeAccount(3));
    });

    test("leaves a deposit booking owing the remainder", async () => {
      const legs = (
        await mapBooking(
          facts({ amountPaid: 2000, lines: [{ gross: 10000, listingId: 1 }] }),
        )
      ).map(asTransfer);
      expect(balanceOf(attendeeAccount(3))(legs)).toBe(-8000); // owes £80
    });

    test("shares one event group and emits a distinct reference per leg", async () => {
      const legs = await mapBooking(
        facts({ amountPaid: 5000, lines: [{ gross: 5000, listingId: 1 }] }),
      );
      expect(new Set(legs.map((l) => l.eventGroup)).size).toBe(1);
      expect(new Set(legs.map((l) => l.reference)).size).toBe(legs.length);
    });

    test("is deterministic across calls (idempotent references)", async () => {
      const input = facts({
        amountPaid: 5000,
        lines: [{ gross: 5000, listingId: 1 }],
      });
      const first = await mapBooking(input);
      const second = await mapBooking(input);
      expect(first.map((l) => l.reference)).toEqual(
        second.map((l) => l.reference),
      );
    });

    test("aggregates multiple lines for one listing into a single sale leg", async () => {
      const legs = await mapBooking(
        facts({
          amountPaid: 5000,
          lines: [
            { gross: 3000, listingId: 1 },
            { gross: 2000, listingId: 1 }, // discount split — same listing
          ],
        }),
      );
      const sales = legs.filter((l) => l.kind === "sale");
      expect(sales.length).toBe(1);
      expect(sales[0]!.amount).toBe(5000);
      expect(new Set(legs.map((l) => l.reference)).size).toBe(legs.length);
    });

    test("rejects a negative line gross", async () => {
      expect(
        await rejectionMessage(
          mapBooking(facts({ lines: [{ gross: -100, listingId: 1 }] })),
        ),
      ).toContain("negative listing 1 gross");
    });

    test("rejects a negative booking fee", async () => {
      expect(
        await rejectionMessage(mapBooking(facts({ bookingFee: -10 }))),
      ).toContain("negative bookingFee");
    });

    test("rejects a negative amount paid", async () => {
      expect(
        await rejectionMessage(mapBooking(facts({ amountPaid: -50 }))),
      ).toContain("negative amountPaid");
    });

    test("rejects a non-finite (NaN) gross", async () => {
      expect(
        await rejectionMessage(
          mapBooking(facts({ lines: [{ gross: Number.NaN, listingId: 1 }] })),
        ),
      ).toContain("non-finite listing 1 gross");
    });

    test("rejects a fractional line gross (minor units must be integers)", async () => {
      expect(
        await rejectionMessage(
          mapBooking(facts({ lines: [{ gross: 10.5, listingId: 1 }] })),
        ),
      ).toContain("non-integer listing 1 gross");
    });

    test("rejects a fractional modifier delta", async () => {
      expect(
        await rejectionMessage(
          mapBooking(facts({ modifiers: [{ delta: -2.5, modifierId: 7 }] })),
        ),
      ).toContain("non-integer modifier 7 delta");
    });

    test("rejects a non-finite modifier delta", async () => {
      expect(
        await rejectionMessage(
          mapBooking(
            facts({ modifiers: [{ delta: Number.NaN, modifierId: 7 }] }),
          ),
        ),
      ).toContain("non-finite modifier 7 delta");
    });

    test("rejects an empty event id", async () => {
      expect(
        await rejectionMessage(mapBooking(facts({ eventId: "" }))),
      ).toContain("empty eventId");
    });

    test("rejects a whitespace-only event id", async () => {
      expect(
        await rejectionMessage(mapBooking(facts({ eventId: "   " }))),
      ).toContain("empty eventId");
    });

    test("drops zero-amount legs (a free booking posts nothing)", async () => {
      const legs = await mapBooking(
        facts({
          lines: [{ gross: 0, listingId: 1 }],
          modifiers: [{ delta: 0, modifierId: 10 }],
        }),
      );
      expect(legs).toEqual([]);
    });
  });

  describe("mapRefund", () => {
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

    test("reverses every leg so revenue, the attendee and cash return to zero", async () => {
      const order = await bookingOrder({
        amountPaid: 7850,
        bookingFee: 150,
        lines: [
          { gross: 5000, listingId: 1 },
          { gross: 3000, listingId: 2 },
        ],
        modifiers: [
          { delta: -500, modifierId: 10 },
          { delta: 200, modifierId: 11 },
        ],
      });
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
      const base = {
        amount: 100,
        destination: revenueAccount(1),
        eventGroup: "g",
        id: 1,
        occurredAt: REFUND_AT,
        recordedAt: REFUND_AT,
        source: attendeeAccount(3),
      };
      const refund = await mapRefund({
        occurredAt: REFUND_AT,
        orderLegs: [
          { ...base, kind: "adjustment", reference: "a" },
          { ...base, kind: undefined, reference: "b" },
        ],
      });
      expect(refund.map((l) => l.kind)).toEqual([
        "refund_adjustment",
        "refund_",
      ]);
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
});
