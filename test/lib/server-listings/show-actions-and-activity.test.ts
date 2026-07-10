// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { addDays } from "#shared/dates.ts";
import { createSystemNote } from "#shared/db/system-notes.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createPaidAttendeeWithoutLedger,
  createTestAttendee,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectFlashRedirect,
  logActivity,
  setupListingAndLogin,
  submitTicketForm,
} from "#test-utils";
import { postListingSale, postWriteoffAdjustment } from "#test-utils/ledger.ts";

// jscpd:ignore-end

describeWithEnv(
  "server listings > show actions and activity",
  { db: true },
  () => {
    describe("GET /admin/listing/:id", () => {
      test("a check-in flashes a confirmation naming the attendee and in/out status", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Ada Lovelace",
          "ada@example.com",
        );

        // Checking in redirects to the Attendees tab with a flash naming the
        // attendee and the in status — the old ?checkin_name= URL surface is gone.
        const { response: inResponse } = await adminFormPost(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
          {},
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/attendees`,
          "Checked Ada Lovelace in",
        )(inResponse);

        // Toggling again checks the attendee out, flashing the out confirmation.
        const { response: outResponse } = await adminFormPost(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
          {},
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/attendees`,
          "Checked Ada Lovelace out",
        )(outResponse);
      });
      test("keeps the email action enabled when the date filter hides emailable attendees", async () => {
        const visibleDate = addDays(todayInTz("UTC"), 1);
        const hiddenDate = addDays(todayInTz("UTC"), 2);
        const listing = await createTestListing({
          bookableDays: [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
          ],
          listingType: "daily",
          maximumDaysAfter: 14,
          minimumDaysBefore: 0,
        });
        await submitTicketForm(listing.slug, {
          date: visibleDate,
          email: "ada@example.com",
          name: "Ada Lovelace",
        });

        // The Email action now lives on the Actions tab, independent of the
        // roster's date filter, so a date that hides every attendee never
        // disables it.
        const response = await adminGet(
          `/admin/listing/${listing.id}/actions?date=${hiddenDate}`,
        );
        const html = await response.text();
        expect(html).not.toContain("Ada Lovelace");
        expect(html).toContain(`href="/admin/emails?listing=${listing.id}"`);
        expect(html).not.toContain("btn--disabled");
      });
      test("Overview collates counts, revenue and notes without loading attendees", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
          name: "Collated Overview",
          thankYouUrl: "https://example.com",
          unitPrice: 500,
        });
        // A confirmed buyer (sale + full payment) who has an operator note.
        const confirmed = await createPaidAttendeeWithoutLedger(
          listing.id,
          "Grace Hopper",
          "grace@example.com",
          "pi_confirmed",
          5000,
        );
        await postListingSale({
          attendeeId: confirmed.id,
          gross: 5000,
          listingId: listing.id,
        });
        await createSystemNote(confirmed.id, "Called ahead about access");
        // An incomplete booking: a recognised sale that was never paid.
        const incomplete = await createPaidAttendeeWithoutLedger(
          listing.id,
          "Abandoned Cart",
          "cart@example.com",
          "",
          3000,
        );
        await postListingSale({
          amountPaid: 0,
          attendeeId: incomplete.id,
          gross: 3000,
          listingId: listing.id,
        });
        await postWriteoffAdjustment(attendeeAccount(incomplete.id), 3000, [
          "clear-incomplete",
          incomplete.id,
        ]);

        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}`,
          {
            cookie,
          },
        );
        const html = await response.text();
        // The confirmed count excludes the incomplete booking (2 booked − 1).
        expect(html).toContain("1 / 100");
        // Received revenue is the paid sale only (£50), not the £80 gross.
        expect(html).toContain("Total Revenue");
        expect(html).toContain("£50");
        // The note (with its author's decrypted name) renders on the Overview.
        expect(html).toContain("Called ahead about access");
        expect(html).toContain("Grace Hopper");
      });
      test("shows the full activity log on the Activity tab", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
          name: "Activity Listing",
        });
        await logActivity("A notable listing event", listing.id);

        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}/activity`,
          { cookie },
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("A notable listing event");
      });
      test("offers the reactivate action for a deactivated listing", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
          name: "Reactivatable Listing",
        });
        await deactivateTestListing(listing.id);

        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}/actions`,
          { cookie },
        );
        const html = await response.text();
        // A deactivated listing shows reactivate, never deactivate.
        expect(html).toContain(`/admin/listing/${listing.id}/reactivate`);
        expect(html).not.toContain(`/admin/listing/${listing.id}/deactivate`);
      });
    });
  },
);
