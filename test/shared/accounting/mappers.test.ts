import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WORLD,
} from "#accounting/accounts.ts";
import { mapBooking } from "#accounting/mappers.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import {
  asTransfer,
  facts,
  paidBookingNettingToZero,
  soleLegOf,
} from "#test/shared/accounting/mappers/fixtures.ts";
import { rejectionMessage } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("accounting > mapBooking", { encryptionKey: true }, () => {
  const theModifierLeg = soleLegOf("modifier");

  test("books gross, modifiers, fee and payment; a paid booking nets to zero", async () => {
    const legs = (await mapBooking(facts(paidBookingNettingToZero))).map(
      asTransfer,
    );

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
    const surcharge = theModifierLeg(
      await mapBooking(facts({ modifiers: [{ delta: 200, modifierId: 11 }] })),
    );
    expect(surcharge.amount).toBe(200);
    expect(surcharge.source).toEqual(attendeeAccount(3));
    expect(surcharge.destination).toEqual(modifierAccount(11));

    const discount = theModifierLeg(
      await mapBooking(facts({ modifiers: [{ delta: -500, modifierId: 10 }] })),
    );
    expect(discount.amount).toBe(500);
    expect(discount.source).toEqual(modifierAccount(10));
    expect(discount.destination).toEqual(attendeeAccount(3));
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

  test("posts every one-unit leg — the smallest money there is", async () => {
    // A gross, fee and payment of exactly 1 minor unit must survive the
    // zero-drop guard, not fall through it.
    const legs: readonly TransferInput[] = await mapBooking(
      facts({
        amountPaid: 1,
        bookingFee: 1,
        lines: [{ gross: 1, listingId: 1 }],
      }),
    );
    expect(soleLegOf("sale")(legs).amount).toBe(1);
    expect(soleLegOf("fee")(legs).amount).toBe(1);
    expect(soleLegOf("payment")(legs).amount).toBe(1);
  });

  test("posts a one-unit surcharge and discount at their smallest size", async () => {
    const surcharge = theModifierLeg(
      await mapBooking(facts({ modifiers: [{ delta: 1, modifierId: 11 }] })),
    );
    expect(surcharge.amount).toBe(1);
    expect(surcharge.source).toEqual(attendeeAccount(3));

    const discount = theModifierLeg(
      await mapBooking(facts({ modifiers: [{ delta: -1, modifierId: 10 }] })),
    );
    expect(discount.amount).toBe(1);
    expect(discount.destination).toEqual(attendeeAccount(3));
  });

  test("joins every invalid fact into one report, comma-separated", async () => {
    expect(
      await rejectionMessage(
        mapBooking(facts({ amountPaid: -50, bookingFee: -10, eventId: "" })),
      ),
    ).toBe(
      "mapBooking: invalid facts (empty eventId, negative bookingFee, negative amountPaid)",
    );
  });
});
