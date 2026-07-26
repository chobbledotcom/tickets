import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { CreateAttendeeResult } from "#shared/db/attendee-types.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { everydayDailyListing } from "#test/test-utils/attendee-form/helpers.ts";
import {
  expectHtmlResponse,
  expectListingRowQuantity,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminGet,
  createTestManagerSession,
  testCookie,
} from "#test-utils/session.ts";

describeWithEnv(
  "server (unified attendee form) — edit-page panels",
  { db: true },
  () => {
    describe("bookings summary on the edit page", () => {
      test("lists each booked listing with its quantity and a total", async () => {
        const kayak = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Kayak Trip",
        });
        const canoe = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Canoe Trip",
        });
        const created = await attendeesApi.createAttendeeAtomic({
          bookings: [
            { listingId: kayak.id, quantity: 2 },
            { listingId: canoe.id, quantity: 3 },
          ],
          email: "booker@example.com",
          name: "Booker",
        });
        if (!created.success) throw new Error("setup");
        const attendeeId = created.attendees[0]!.id;

        const response = await adminGet(`/admin/attendees/${attendeeId}`);
        const html = await expectHtmlResponse(
          response,
          200,
          "Bookings",
          "Kayak Trip",
          "Canoe Trip",
        );
        // Each listing's own row shows its quantity (Kayak→2, Canoe→3), so a
        // swapped grouping fails here, not just a wrong sum...
        expectListingRowQuantity(html, kayak.id, 2);
        expectListingRowQuantity(html, canoe.id, 3);
        // ...and the summary footer totals them (2 + 3 = 5).
        expect(html).toContain('<td class="col-quantity">5</td>');
      });

      test("surfaces the checked-in status of a booking", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          name: "Tour",
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Arrived",
          "arrived@example.com",
        );
        const { updateCheckedIn } = await import(
          "#shared/db/attendees/update.ts"
        );
        await updateCheckedIn(attendee.id, listing.id, true);

        const response = await adminGet(`/admin/attendees/${attendee.id}`);
        const html = await expectHtmlResponse(response, 200, "Bookings");
        // Assert the rendered badge markup, not just the words "Checked in",
        // so a mutant that drops the badge styling/element is still caught.
        expect(html).toContain('<span class="badge">Checked in</span>');
      });
    });

    describe("ledger tab on the attendee page", () => {
      /** Seed an attendee with a fully-paid sale (so the statement has a sale
       * leg whose counterparty is the listing and a payment leg whose
       * counterparty is the card/bank singleton). */
      const seedLedgerAttendee = async (): Promise<number> => {
        const listing = await createTestListing({
          maxAttendees: 50,
          name: "Pottery Class",
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Ledger Lou",
          "lou@example.com",
        );
        await postListingSale({
          attendeeId: attendee.id,
          gross: 2500,
          listingId: listing.id,
        });
        return attendee.id;
      };

      test("an owner sees the attendee's running-balance statement with counterparties", async () => {
        const id = await seedLedgerAttendee();
        const response = await awaitTestRequest(
          `/admin/attendees/${id}/ledger`,
          {
            cookie: await testCookie(),
          },
        );
        const html = await expectHtmlResponse(response, 200);
        expect(html).toContain("<th>Other side</th>");
        // The sale's counterparty links to the listing; the payment's is card/bank.
        expect(html).toContain("Pottery Class");
        expect(html).toContain("Card / bank");
      });

      test("a manager's Ledger tab 404s and is absent from the strip (owner-only money movements)", async () => {
        // The tab exposes payment/refund/writeoff legs, so it is owner-only —
        // matching the standalone /admin/ledger* routes. Naming the URL directly
        // 404s (visibility IS authorization), and the strip never links it.
        const id = await seedLedgerAttendee();
        const managerCookie = await createTestManagerSession();
        const direct = await awaitTestRequest(`/admin/attendees/${id}/ledger`, {
          cookie: managerCookie,
        });
        expect(direct.status).toBe(404);
        const overview = await awaitTestRequest(`/admin/attendees/${id}`, {
          cookie: managerCookie,
        });
        const html = await expectHtmlResponse(overview, 200);
        expect(html).not.toContain(`/admin/attendees/${id}/ledger`);
        expect(html).not.toContain("<th>Other side</th>");
      });
    });

    describe("daily defaults + mixed-timing alert on the edit page", () => {
      /** Book an attendee across `bookings` and return its rendered edit page. */
      const editPageHtmlForBookings = async (
        bookings: Parameters<
          typeof attendeesApi.createAttendeeAtomic
        >[0]["bookings"],
      ): Promise<string> => {
        const result = await attendeesApi.createAttendeeAtomic({
          bookings,
          email: "",
          name: "Timing",
        });
        if (!result.success) throw new Error("setup");
        const response = await adminGet(
          `/admin/attendees/${result.attendees[0]!.id}/edit`,
        );
        return response.text();
      };

      test("shows the mixed-timing alert when daily bookings differ in start date", async () => {
        const daily = await everydayDailyListing({ name: "Mixed Daily" });
        // Two distinct dates for one attendee — both daily, different starts.
        const html = await editPageHtmlForBookings([
          { date: "2026-06-15", listingId: daily.id, quantity: 1 },
          { date: "2026-06-20", listingId: daily.id, quantity: 1 },
        ]);
        expect(html).toContain("different start dates or lengths");
      });

      test("does not show the mixed-timing alert when daily bookings are uniform", async () => {
        const daily = await everydayDailyListing({ name: "Uniform Daily" });
        const html = await editPageHtmlForBookings([
          { date: "2026-06-15", listingId: daily.id, quantity: 1 },
        ]);
        expect(html).not.toContain("different start dates or lengths");
      });
    });

    describe("over-duration warnings", () => {
      /** Render the edit page for a create/book result, asserting it loaded. */
      const editPageHtml = async (
        result: CreateAttendeeResult,
      ): Promise<string> => {
        const attendeeId = result.success ? result.attendees[0]!.id : 0;
        const response = await adminGet(`/admin/attendees/${attendeeId}/edit`);
        return expectHtmlResponse(response, 200);
      };

      test("warns when the range is longer than a daily listing allows", async () => {
        const oneDay = await createDailyTestListing({
          durationDays: 1,
          name: "One Day",
        });
        const twoDay = await createDailyTestListing({
          durationDays: 2,
          name: "Two Day",
        });
        const result = await attendeesApi.createAttendeeAtomic({
          bookings: [
            { date: "2026-05-01", durationDays: 3, listingId: oneDay.id },
            { date: "2026-05-01", durationDays: 3, listingId: twoDay.id },
          ],
          email: "",
          name: "Over",
        });
        const html = await editPageHtml(result);
        // Per-listing warnings (singular + plural) and a top-of-page summary.
        expect(html).toContain(
          "One Day is designed for up to 1 day, but the booking spans 3.",
        );
        expect(html).toContain(
          "Two Day is designed for up to 2 days, but the booking spans 3.",
        );
        expect(html).toContain("Please double-check");
      });

      test("no warning when the range fits the listing's duration", async () => {
        const daily = await createDailyTestListing({
          durationDays: 3,
          name: "Three Day",
        });
        const result = await bookAttendee(daily, {
          date: "2026-05-01",
          durationDays: 3,
        });
        const html = await editPageHtml(result);
        expect(html).not.toContain("Please double-check");
      });
    });
  },
);
