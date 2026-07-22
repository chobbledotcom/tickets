// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { twoListingsAttendees } from "#test/lib/attendee-read-helpers.ts";
import { expectReservedRedirectWithTokens } from "#test-utils/assertions.ts";
import {
  bookOneEachViaTicketForm,
  expectBookOneEachRejected,
  expectMissingCsrfRejected,
  submitMultiTicketForm,
} from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

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
        const { attendeesApi } = await import("#shared/db/attendees/api.ts");
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
        const [attendees1, attendees2] = await twoListingsAttendees(
          listing1.id,
          listing2.id,
        );
        expect(attendees1.length).toBe(0);
        expect(attendees2.length).toBe(1);
      });
    });

    describe("routes/public.ts (withPaymentProvider onMissing ticket)", () => {
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
