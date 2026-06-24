import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import {
  bookingLedgerPoster,
  createOrSoldOut,
  ModifierSoldOutError,
} from "#shared/checkout-complete.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { createAttendeeAtomic, getAttendeesRaw } from "#shared/db/attendees.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import {
  createTestListing,
  describeWithEnv,
  pricedLine as line,
  pricedOrder as order,
} from "#test-utils";

/** A free-path ledger context: keyed on the attendee id, dated at a fixed clock. */
const ledgerFor = (pricedOrder: PricedOrder) => ({
  currency: "GBP",
  eventId: (attendeeId: number) => `free-${attendeeId}`,
  occurredAt: "2026-06-21T00:00:00.000Z",
  pricedOrder,
});

/** The minimal create input: one booking for the listing, one contact. */
const bookOneOf = (listingId: number) => ({
  bookings: [{ listingId, quantity: 1 }],
  email: "a@b.c",
  name: "A",
});

/** A modifier with zero stock: its guarded usage insert never lands a row, so a
 *  booking that tries to consume it is rejected exactly as a sold-out race is. */
const soldOutModifier = () =>
  modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 5,
    direction: "charge",
    name: "Add-on",
    stock: 0,
  });

const usage = (modifierId: number, amountApplied = 500) => ({
  amountApplied,
  modifierId,
  quantity: 1,
});

describeWithEnv("shared > checkout-complete", { db: true }, () => {
  describe("bookingLedgerPoster", () => {
    test("recognises the gross sale and leaves the full amount owed for a zero-total order", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const result = await createAttendeeAtomic(
        bookOneOf(listing.id),
        bookingLedgerPoster(
          [],
          ledgerFor(
            order({
              fullSubtotal: 5000,
              lines: [line(listing.id, 5000, 1)],
              total: 0,
            }),
          ),
        ),
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      const attendeeId = result.attendees[0]!.id;
      // Revenue is recognised gross at sale; nothing was paid now, so the attendee
      // still owes the full amount — one sale leg, the zero payment leg dropped.
      expect(await accountBalance(revenueAccount(listing.id))).toBe(5000);
      expect(await accountBalance(attendeeAccount(attendeeId))).toBe(-5000);
      expect(
        (await transfersByAccount(attendeeAccount(attendeeId))).length,
      ).toBe(1);
    });

    test("consumes modifier stock without touching the ledger when no order is given", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const m = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Add-on",
        stock: null,
      });

      const result = await createAttendeeAtomic(
        bookOneOf(listing.id),
        bookingLedgerPoster([usage(m.id, 0)], null),
      );

      expect(result.success).toBe(true);
      // Stock was consumed (a usage row exists) but no money was recorded.
      expect(await modifierUsedQuantities([m.id])).toEqual(
        new Map([[m.id, 1]]),
      );
      expect((await allTransfers()).length).toBe(0);
    });

    test("throws ModifierSoldOutError and rolls everything back when a modifier is sold out", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const m = await soldOutModifier();

      await expect(
        createAttendeeAtomic(
          bookOneOf(listing.id),
          bookingLedgerPoster(
            [usage(m.id)],
            ledgerFor(
              order({
                fullSubtotal: 5000,
                lines: [line(listing.id, 5000, 1)],
                total: 0,
              }),
            ),
          ),
        ),
      ).rejects.toThrow(ModifierSoldOutError);

      // No attendee, no legs, and no usage row survived the rollback.
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      expect((await allTransfers()).length).toBe(0);
      expect(await modifierUsedQuantities([m.id])).toEqual(new Map());
    });
  });

  describe("createOrSoldOut", () => {
    test("returns the create result when the poster succeeds", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });

      const result = await createOrSoldOut(bookOneOf(listing.id), () =>
        Promise.resolve(),
      );

      expect(result).not.toBe("sold-out");
      if (result === "sold-out") return;
      expect(result.success).toBe(true);
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    });

    test("returns 'sold-out' and rolls the create back when the poster reports a sold-out modifier", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });

      const result = await createOrSoldOut(bookOneOf(listing.id), () =>
        Promise.reject(new ModifierSoldOutError()),
      );

      expect(result).toBe("sold-out");
      // The throw rolled the interactive transaction back: no attendee survived.
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });

    test("re-throws any error that is not a sold-out", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });

      await expect(
        createOrSoldOut(bookOneOf(listing.id), () =>
          Promise.reject(new Error("ledger boom")),
        ),
      ).rejects.toThrow("ledger boom");
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });
  });
});
