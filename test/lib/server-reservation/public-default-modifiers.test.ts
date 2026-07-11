import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { hashEmail, recordVisit } from "#shared/db/contact-preferences.ts";
import { recordBooking } from "#shared/db/contact-tokens.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { captureCheckoutIntent } from "#test-utils/checkout.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  addServiceCharge,
  attendeeCount,
  modifierUsageAmount,
  setPublicReservation,
  setupSoldOutModifierRace,
  submitBuyerOrder,
  totalContactActivity,
} from "./helpers.ts";

describeWithEnv(
  "server (reservation deposit at checkout)",
  { db: true },
  () => {
    afterEach(() => resetStripeClient());

    test("a reservation public-default carries the deposit amount into checkout", async () => {
      await setupStripe();
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const captured = await captureCheckoutIntent(listing);
      // Items keep their full price; the snapshot tells the provider/webhook to
      // charge and reconcile a 10% deposit.
      expect(captured?.reservationAmount).toBe("10%");
      expect(captured?.items[0]?.unitPrice).toBe(1000);
    });

    test("a reservation public-default still resolves modifiers before checkout", async () => {
      await setupStripe();
      await setPublicReservation("10%");
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      await addServiceCharge();
      const captured = await captureCheckoutIntent(listing);
      expect(captured?.reservationAmount).toBe("10%");
      expect(captured?.modifiers).toHaveLength(1);
      expect(captured?.modifiers?.[0]?.value).toBe(10);
    });

    test("a non-reservation public-default carries no deposit amount", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const captured = await captureCheckoutIntent(listing);
      // The seeded default is a full-payment status, so no deposit snapshot.
      expect(captured?.reservationAmount).toBeUndefined();
    });

    test("carries resolved modifiers into a full-payment checkout", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      await addServiceCharge();
      const captured = await captureCheckoutIntent(listing);
      expect(captured?.modifiers).toHaveLength(1);
      expect(captured?.modifiers?.[0]?.value).toBe(10);
    });

    test("records clamped stock usage for zero-total modifier bookings", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 20,
        direction: "discount",
        name: "Comp",
        stock: 1,
      });

      const response = await submitBuyerOrder(listing);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://example.com");
      expect(await modifierUsedQuantities([modifier.id])).toEqual(
        new Map([[modifier.id, 1]]),
      );
      expect(await modifierUsageAmount(modifier.id)).toBe(1000);
    });

    test("rolls back a zero-total modifier booking when stock sells out after pricing", async () => {
      await setupStripe();
      const { listing, modifier } = await setupSoldOutModifierRace();

      const response = await submitBuyerOrder(listing);

      expect(response.status).toBe(302);
      expect(response.headers.get("location") ?? "").toMatch(
        new RegExp(`^/ticket/${listing.slug}\\?flash=`),
      );
      expectFlash(
        response,
        "An extra you selected sold out while you were checking out. Please try again.",
        false,
      );
      // The racing order's single consumption stands (it really got the stock);
      // our rejected order added none of its own — the batch's stock-guarded
      // booking insert never landed, so its gated usage insert never fired.
      expect(await modifierUsedQuantities([modifier.id])).toEqual(
        new Map([[modifier.id, 1]]),
      );
      expect(await attendeeCount()).toBe(0);
      // A sold-out free order leaves no phantom contact history: the batch never
      // reaches the success path that records a visit + public booking, so there
      // is nothing to compensate (matching the paid SumUp-webhook path).
      expect(await totalContactActivity()).toEqual({ bookings: 0, visits: 0 });
    });

    test("reverses a phone contact's counters when a free order's stock rolls back", async () => {
      await setupStripe();
      // A phone-only listing identifies the buyer by phone hash, exercising the
      // SMS-reachable contact path rather than email.
      const { listing } = await setupSoldOutModifierRace("phone");

      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        name: "Buyer",
        phone: "07700900123",
      });

      expectFlash(
        response,
        "An extra you selected sold out while you were checking out. Please try again.",
        false,
      );
      expect(await attendeeCount()).toBe(0);
      // The phone identity must be compensated just like email: a sold-out free
      // order leaves no visit or booking on the texted contact.
      expect(await totalContactActivity()).toEqual({ bookings: 0, visits: 0 });
    });

    test("keeps a returning contact's earlier booking when a later free order rolls back", async () => {
      await setupStripe();
      // This contact already has one genuine public booking + visit on record.
      const emailHash = await hashEmail("buyer@example.com");
      await recordVisit(emailHash);
      await recordBooking(emailHash, "public", "tok-earlier");

      const { listing } = await setupSoldOutModifierRace();
      const response = await submitBuyerOrder(listing);

      expectFlash(
        response,
        "An extra you selected sold out while you were checking out. Please try again.",
        false,
      );
      expect(await attendeeCount()).toBe(0);
      // The rollback decrements by exactly one (clamped at zero), so the earlier
      // booking survives — a rejected order must never wipe real history.
      expect(await totalContactActivity()).toEqual({ bookings: 1, visits: 1 });
    });
  },
);
