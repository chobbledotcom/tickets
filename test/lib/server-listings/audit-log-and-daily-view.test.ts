// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestAttendee,
  describeWithEnv,
  expectHtmlResponse,
  getListingActivityLog,
  setupListingAndLogin,
  submitTicketForm,
} from "#test-utils";
import { createEveryDayDailyListing } from "#test-utils/daily-listing.ts";

// jscpd:ignore-end

describeWithEnv(
  "server listings > audit log and daily admin view",
  { db: true },
  () => {
    describe("audit logging (listing edit)", () => {
      test("logs activity when listing is updated", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });

        await adminFormPost(`/admin/listing/${listing.id}/edit`, {
          max_attendees: "200",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
          thank_you_url: "https://example.com/updated",
        });

        const logs = await getListingActivityLog(listing.id);
        const updateLog = logs.find((l: { message: string }) =>
          l.message.includes("updated"),
        );
        expect(updateLog).toBeDefined();
        expect(updateLog?.message).toContain(listing.name);
      });
    });
    describe("daily listing admin view", () => {
      const validDate1 = addDays(todayInTz("UTC"), 1);
      const validDate2 = addDays(todayInTz("UTC"), 2);

      const createDailyListingWithAttendees = async () => {
        const listing = await createEveryDayDailyListing();
        // Create attendees on two different dates via the public form
        await submitTicketForm(listing.slug, {
          date: validDate1,
          email: "a@test.com",
          name: "User A",
        });
        await submitTicketForm(listing.slug, {
          date: validDate1,
          email: "b@test.com",
          name: "User B",
        });
        await submitTicketForm(listing.slug, {
          date: validDate2,
          email: "c@test.com",
          name: "User C",
        });
        return listing;
      };

      /** Fetches the Attendees tab roster for a listing (with an optional
       *  query string) and returns its rendered HTML. */
      const getAttendeesRosterHtml = async (
        listing: { id: number },
        query = "",
      ): Promise<string> => {
        const response = await adminGet(
          `/admin/listing/${listing.id}/attendees${query}`,
        );
        return response.text();
      };

      /** Builds the seeded daily listing and returns it alongside its Attendees
       *  roster HTML filtered to the first valid date — the shared starting
       *  point for the export-link and filter-link tests. */
      const datedRoster = async () => {
        const listing = await createDailyListingWithAttendees();
        const html = await getAttendeesRosterHtml(
          listing,
          `?date=${validDate1}`,
        );
        return { html, listing };
      };

      test("shows date selector dropdown for daily listings", async () => {
        const listing = await createDailyListingWithAttendees();

        const response = await adminGet(
          `/admin/listing/${listing.id}/attendees`,
        );
        await expectHtmlResponse(
          response,
          200,
          "<select",
          "All dates",
          validDate1,
          validDate2,
        );
      });

      test("shows Date column header for daily listings", async () => {
        const listing = await createDailyListingWithAttendees();

        const response = await adminGet(
          `/admin/listing/${listing.id}/attendees`,
        );
        const html = await response.text();
        expect(html).toContain("<th>Date</th>");
      });

      test("does not show Date column for standard listings", async () => {
        const { listing, cookie } = await setupListingAndLogin();

        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}`,
          {
            cookie,
          },
        );
        const html = await response.text();
        expect(html).not.toContain("<th>Date</th>");
      });

      test("filters attendees by ?date= parameter", async () => {
        const listing = await createDailyListingWithAttendees();

        // Filter to date1 — should show 2 attendees (User A and User B)
        const html = await getAttendeesRosterHtml(
          listing,
          `?date=${validDate1}`,
        );
        expect(html).toContain("User A");
        expect(html).toContain("User B");
        expect(html).not.toContain("User C");
      });

      test("filters attendees by ?date= showing other date", async () => {
        const listing = await createDailyListingWithAttendees();

        // Filter to date2 — should show 1 attendee (User C)
        const response = await adminGet(
          `/admin/listing/${listing.id}/attendees?date=${validDate2}`,
        );
        const html = await response.text();
        expect(html).toContain("User C");
        expect(html).not.toContain("User A");
      });

      test("scopes the roster to the active date on the Attendees tab", async () => {
        const listing = await createDailyListingWithAttendees();

        const response = await adminGet(
          `/admin/listing/${listing.id}/attendees?date=${validDate1}`,
        );
        const html = await response.text();
        // The date filter scopes the roster to date1's two bookings, and the
        // date selector marks that date as the active option.
        expect(html).toContain("User A");
        expect(html).toContain("User B");
        expect(html).not.toContain("User C");
        expect(html).toContain(
          `/admin/listing/${listing.id}/attendees?date=${validDate1}" selected`,
        );
      });

      test("shows total count without date filter", async () => {
        const listing = await createDailyListingWithAttendees();

        const response = await adminGet(`/admin/listing/${listing.id}`);
        const html = await response.text();
        expect(html).toContain("(total)");
        expect(html).toContain("Capacity of");
      });

      test("date filter composes with check-in filter", async () => {
        const listing = await createDailyListingWithAttendees();

        // Filter to date1 + checked out — should show both since none are checked in
        const html = await getAttendeesRosterHtml(
          listing,
          `?filter=out&date=${validDate1}`,
        );
        expect(html).toContain("User A");
        expect(html).toContain("User B");
        expect(html).not.toContain("User C");
      });

      test("ignores a malformed ?date= and shows all attendees", async () => {
        const listing = await createDailyListingWithAttendees();
        // A bogus date is rejected rather than treated as a filter, so the roster
        // is not emptied — every date's attendees still show.
        const response = await adminGet(
          `/admin/listing/${listing.id}/attendees?date=not-a-date`,
        );
        const html = await response.text();
        expect(html).toContain("User A");
        expect(html).toContain("User C");
      });

      test("shows a date-scoped capacity summary on the roster, only when dated", async () => {
        const listing = await createDailyListingWithAttendees();
        // With a valid date the roster carries the per-date capacity summary
        // (the Overview tab only ever shows whole-listing totals).
        const dated = await (
          await adminGet(
            `/admin/listing/${listing.id}/attendees?date=${validDate1}`,
          )
        ).text();
        expect(dated).toContain('class="listing-details-table"');
        // Without a date the roster shows no capacity table.
        const undated = await (
          await adminGet(`/admin/listing/${listing.id}/attendees`)
        ).text();
        expect(undated).not.toContain('class="listing-details-table"');
      });

      test("ignores ?date= for standard listings", async () => {
        const { listing, cookie } = await setupListingAndLogin();
        await createTestAttendee(
          listing.id,
          listing.slug,
          "Standard User",
          "std@test.com",
        );

        // Even with ?date= param, standard listings show all attendees
        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}/attendees?date=2026-03-15`,
          { cookie },
        );
        const html = await response.text();
        expect(html).toContain("Standard User");
        expect(html).not.toContain("<th>Date</th>");
      });

      test("CSV export includes Date column for daily listings", async () => {
        const listing = await createDailyListingWithAttendees();

        const response = await adminGet(`/admin/listing/${listing.id}/export`);
        await expectHtmlResponse(response, 200, "Date,Name,Email");
      });

      test("CSV export excludes Date column for standard listings", async () => {
        const { listing, cookie } = await setupListingAndLogin();
        await createTestAttendee(
          listing.id,
          listing.slug,
          "CSV User",
          "csv@test.com",
        );

        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}/export`,
          { cookie },
        );
        const csv = await response.text();
        expect(csv.startsWith("Name,Email")).toBe(true);
      });

      test("CSV export filters by ?date= for daily listings", async () => {
        const listing = await createDailyListingWithAttendees();

        const response = await adminGet(
          `/admin/listing/${listing.id}/export?date=${validDate2}`,
        );
        const csv = await response.text();
        expect(csv).toContain("User C");
        expect(csv).not.toContain("User A");
      });

      test("CSV export filename includes date when filtered", async () => {
        const listing = await createDailyListingWithAttendees();

        const response = await adminGet(
          `/admin/listing/${listing.id}/export?date=${validDate1}`,
        );
        const disposition = response.headers.get("content-disposition") ?? "";
        expect(disposition).toContain(validDate1);
        expect(disposition).toContain("_attendees.csv");
      });

      test("Export CSV link includes ?date= when filter is active", async () => {
        const { listing, html } = await datedRoster();
        expect(html).toContain(
          `/admin/listing/${listing.id}/export?date=${validDate1}`,
        );
      });

      test("filter links preserve ?date= query parameter", async () => {
        const { listing, html } = await datedRoster();
        // The roster's check-in filters are query params now (&amp; in rendered
        // HTML), not the old /in and /out path segments with an #attendees anchor.
        expect(html).toContain(
          `/admin/listing/${listing.id}/attendees?filter=in&amp;date=${validDate1}`,
        );
        expect(html).toContain(
          `/admin/listing/${listing.id}/attendees?filter=out&amp;date=${validDate1}`,
        );
      });
    });
  },
);
