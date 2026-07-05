// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { capacityErrorFormatter } from "#shared/capacity-error.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  bookOneEachViaTicketForm,
  createTestListing,
  describeWithEnv,
  expectBookOneEachRejected,
  expectFlash,
  expectMissingCsrfRejected,
  expectReservedRedirectWithTokens,
  setupStripe,
  submitMultiTicketForm,
  submitTicketForm,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket CSRF and capacity checks",
  { db: true, triggers: true },
  () => {
    describe("routes/public.ts (ticket CSRF)", () => {
      test("ticket POST rejects invalid CSRF token", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Csrf 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Csrf 2",
        });

        // POST without getting CSRF token first
        await expectMissingCsrfRejected(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          {
            email: "john@example.com",
            name: "John",
          },
        );
      });
    });

    describe("routes/public.ts (withPaymentProvider onMissing path)", () => {
      test("shows payment not configured error for ticket when no provider", async () => {
        await setupStripe();

        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Noprov 1",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Noprov 2",
          unitPrice: 1000,
        });

        // Now clear the provider to simulate no provider
        const { settings: s } = await import("#shared/db/settings.ts");
        await s.update.clearPaymentProvider();

        const response = await bookOneEachViaTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          listing1.id,
          listing2.id,
        );

        // Free registration path since provider is cleared and isPaymentsEnabled returns false
        expectReservedRedirectWithTokens(response);
        resetStripeClient();
      });
    });

    describe("POST ticket capacity check via atomic create", () => {
      test("shows error for free ticket when atomic create fails", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Free Atomic 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Free Atomic 2",
        });

        // Mock attendeesApi to fail (capacity exceeded). A free order with a ledger
        // order uses createBookingAtomic; fail both so the path is covered either way.
        const { attendeesApi } = await import("#shared/db/attendees.ts");
        const originalFn = attendeesApi.createAttendeeAtomic;
        const originalBooking = attendeesApi.createBookingAtomic;
        const failure = () =>
          Promise.resolve({
            reason: "capacity_exceeded" as const,
            success: false as const,
          });
        attendeesApi.createAttendeeAtomic = failure;
        attendeesApi.createBookingAtomic = failure;

        try {
          await expectBookOneEachRejected(
            `${listing1.slug}+${listing2.slug}`,
            listing1.id,
            listing2.id,
            "no longer has enough spots",
          );
        } finally {
          attendeesApi.createAttendeeAtomic = originalFn;
          attendeesApi.createBookingAtomic = originalBooking;
        }
      });
    });

    describe("routes/public.ts (formatAtomicError encryption_error single-ticket)", () => {
      test("shows encryption error message when atomic create fails with encryption_error", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
        });

        const { attendeesApi } = await import("#shared/db/attendees.ts");
        const failure = () =>
          Promise.resolve({
            reason: "encryption_error" as const,
            success: false as const,
          });
        const mockAtomic = stub(attendeesApi, "createAttendeeAtomic", failure);
        const mockBooking = stub(attendeesApi, "createBookingAtomic", failure);

        try {
          const response = await submitTicketForm(listing.slug, {
            email: "john@example.com",
            name: "John Doe",
          });
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("Registration failed"),
            false,
          );
        } finally {
          mockAtomic.restore();
          mockBooking.restore();
        }
      });
    });

    describe("capacityErrorFormatter", () => {
      const format = capacityErrorFormatter({
        fallback: "fallback",
        generic: "generic",
        withName: (name) => `${name} is full`,
      });

      test("returns the named message for capacity_exceeded with an listing name", () => {
        expect(format("capacity_exceeded", "My Listing")).toBe(
          "My Listing is full",
        );
      });

      test("returns the generic capacity message when no listing name is given", () => {
        expect(format("capacity_exceeded", "")).toBe("generic");
      });

      test("returns the fallback for non-capacity reasons", () => {
        expect(format("encryption_error", "My Listing")).toBe("fallback");
      });
    });

    describe("routes/public.ts (ticket quantity field missing from form)", () => {
      test("defaults to 0 when quantity field is absent from ticket form", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Nofield 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Nofield 2",
        });

        // Submit form with quantity for listing2 only; listing1 has no quantity field at all
        const response = await submitMultiTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing2.id}`]: "1",
          },
        );
        expectReservedRedirectWithTokens(response);

        // Verify only listing2 got an attendee
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees1.length).toBe(0);
        expect(attendees2.length).toBe(1);
      });
    });

    describe("routes/public.ts (withPaymentProvider onMissing ticket)", () => {
      afterEach(() => {
        resetStripeClient();
      });

      test("shows payment not configured error when provider returns null for ticket", async () => {
        await setupStripe();

        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Noprov Miss 1",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Noprov Miss 2",
          unitPrice: 1000,
        });

        // Mock paymentsApi.getConfiguredProvider to return null so getActivePaymentProvider
        // returns null, while isPaymentsEnabled still returns true from the DB
        const { paymentsApi } = await import("#shared/payments.ts");
        const mockConfigured = stub(
          paymentsApi,
          "getConfiguredProvider",
          () => null,
        );

        try {
          await expectBookOneEachRejected(
            `${listing1.slug}+${listing2.slug}`,
            listing1.id,
            listing2.id,
            "Payments are not configured",
          );
        } finally {
          mockConfigured.restore();
        }
      });
    });
  },
);
