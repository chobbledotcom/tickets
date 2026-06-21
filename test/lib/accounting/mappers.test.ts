import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { type BookingFacts, mapBooking } from "#shared/accounting/mappers.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { describeWithEnv } from "#test-utils";

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
  currency: "GBP",
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
});
