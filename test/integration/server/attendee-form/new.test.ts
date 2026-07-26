import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeLineIndex,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { hasSelectedOption } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "server (unified attendee form) — new form",
  { db: true },
  () => {
    describe("GET /admin/attendees/new", () => {
      /** Seed one standard "Pick Me" listing and return the rendered bare create
       *  form (asserting it loaded with a 200). */
      const bareCreateForm = async (): Promise<string> => {
        await createTestListing({ maxAttendees: 100, name: "Pick Me" });
        const response = await adminGet("/admin/attendees/new");
        return expectHtmlResponse(response, 200);
      };

      testRequiresAuth("/admin/attendees/new");

      test("renders the create form with a quantity box per listing", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          name: "Pick Me",
        });
        const response = await adminGet("/admin/attendees/new");
        const html = await expectHtmlResponse(
          response,
          200,
          "Add new attendee",
          "Listing Registrations",
          "Create Attendee",
          "Pick Me",
        );
        // A quantity box per listing, and no add-line button (fixed table).
        expect(attendeeLineIndex(html, listing.id)).not.toBeNull();
        expect(html).not.toContain("Add Listing Line");
        // A clean form has no errors, so the name field keeps its autofocus and
        // no error alert claims it.
        expect(html).toContain(`autocomplete="off" autofocus id="name"`);
        expect(html).not.toContain("autofocus class=");
      });

      test("hides the date fields when there are no daily listings", async () => {
        // The shared date range only affects daily listings, so a site with only
        // standard (fixed-date) listings never sees the Dates section.
        await createTestListing({ maxAttendees: 100, name: "Standard Only" });
        const response = await adminGet("/admin/attendees/new");
        const html = await expectHtmlResponse(response, 200);
        expect(html).not.toContain('name="start_date"');
        expect(html).not.toContain('id="day_count"');
        expect(html).not.toContain("only affects daily listings");
      });

      test("shows the optional date fields when a daily listing exists", async () => {
        await createDailyTestListing({ name: "Daily One" });
        const response = await adminGet("/admin/attendees/new");
        const html = await expectHtmlResponse(response, 200);
        expect(html).toContain('name="start_date"');
        expect(html).toContain('id="day_count"');
        // The note makes clear the date is optional and daily-only.
        expect(html).toContain("only affects daily listings");
      });

      test("omits the 'Back without saving' link", async () => {
        // The browser back button is enough; the explicit link was removed.
        const html = await bareCreateForm();
        expect(html).not.toContain("Back without saving");
      });

      test("shows the availability notice on a dateless create form", async () => {
        await createDailyTestListing({ name: "L" });
        const response = await adminGet("/admin/attendees/new");
        const html = await expectHtmlResponse(
          response,
          200,
          "Availability is inaccurate until dates have been saved",
        );
        // Visible (not hidden) when no date is known.
        expect(html).toContain("data-availability-notice>");
      });

      test("hides the availability notice when a date is pre-filled", async () => {
        const listing = await createDailyTestListing({ name: "D" });
        const response = await adminGet(
          `/admin/attendees/new?select_${listing.id}=1&start_date=2026-07-01`,
        );
        const html = await expectHtmlResponse(response, 200);
        expect(html).toContain("data-availability-notice hidden>");
      });

      test("pre-fills listings selected from the calendar checker", async () => {
        const a = await createTestListing({ maxAttendees: 100, name: "Kayak" });
        const b = await createTestListing({ maxAttendees: 100, name: "Canoe" });
        const response = await adminGet(
          `/admin/attendees/new?select_${a.id}=1&select_${b.id}=1`,
        );
        const html = await expectHtmlResponse(response, 200);
        // Both chosen listings start at quantity 1.
        expect(html).toMatch(
          new RegExp(
            `name="qty_${attendeeLineIndex(html, a.id)}"[^>]*value="1"`,
          ),
        );
        expect(html).toMatch(
          new RegExp(
            `name="qty_${attendeeLineIndex(html, b.id)}"[^>]*value="1"`,
          ),
        );
      });

      test("omits the 'Show all listings' toggle on a bare create form", async () => {
        // Nothing is booked yet, so an un-ticked toggle would hide every row.
        // Instead the form drops the toggle and shows every listing.
        const html = await bareCreateForm();
        expect(html).not.toContain("Show all listings");
        expect(html).not.toContain('name="show_all"');
        // The editor carries the show-all modifier so the not-booked rows stay
        // visible despite the CSS that hides them under the toggle.
        expect(html).toContain("listing-editor show-all-listings");
      });

      test("keeps the un-ticked 'Show all listings' toggle when listings are pre-filled", async () => {
        // A calendar deep link pre-selects a listing; the other rows stay tucked
        // behind the toggle, which starts un-ticked.
        const picked = await createTestListing({
          maxAttendees: 100,
          name: "Kayak",
        });
        await createTestListing({ maxAttendees: 100, name: "Canoe" });
        const response = await adminGet(
          `/admin/attendees/new?select_${picked.id}=1`,
        );
        const html = await expectHtmlResponse(
          response,
          200,
          "Show all listings",
        );
        expect(html).toContain('name="show_all"');
        // Un-ticked: the checkbox carries no `checked` attribute.
        expect(html).not.toMatch(/name="show_all"[^>]*checked/);
        expect(html).not.toContain("listing-editor show-all-listings");
      });

      test("pre-fills the shared start date from the deep link", async () => {
        const listing = await createDailyTestListing({ name: "Daily Pick" });
        const response = await adminGet(
          `/admin/attendees/new?select_${listing.id}=1&start_date=2026-07-01`,
        );
        const html = await expectHtmlResponse(response, 200);
        expect(html).toMatch(
          new RegExp(
            `name="qty_${attendeeLineIndex(html, listing.id)}"[^>]*value="1"`,
          ),
        );
        expect(html).toContain('value="2026-07-01"');
      });

      test("leaves the start date blank when the deep link omits it", async () => {
        const listing = await createDailyTestListing({ name: "No Date Daily" });
        const response = await adminGet(
          `/admin/attendees/new?select_${listing.id}=1`,
        );
        const html = await expectHtmlResponse(response, 200);
        expect(html).toMatch(
          new RegExp(
            `name="qty_${attendeeLineIndex(html, listing.id)}"[^>]*value="1"`,
          ),
        );
        expect(html).toMatch(/name="start_date"[^>]*value=""/);
      });

      test("falls back to all-zero quantities when no selection resolves", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          name: "Z",
        });
        const response = await adminGet("/admin/attendees/new?select_999999=1");
        const html = await expectHtmlResponse(response, 200);
        expect(html).toMatch(
          new RegExp(
            `name="qty_${attendeeLineIndex(html, listing.id)}"[^>]*value="0"`,
          ),
        );
      });

      test("seeds the shared length from an existing multi-day booking", async () => {
        const listing = await createTestListing({
          customisableDays: true,
          dayPrices: { 1: 0, 2: 0, 3: 0 },
          durationDays: 3,
          listingType: "daily",
          maxAttendees: 50,
        });
        const result = await bookAttendee(listing, {
          date: "2026-09-10",
          durationDays: 2,
        });
        const attendeeId = result.success ? result.attendees[0]!.id : 0;

        const response = await adminGet(`/admin/attendees/${attendeeId}/edit`);
        const html = await response.text();
        // The shared day-count select preselects the booking's current 2-day span.
        expect(html).toContain('id="day_count"');
        expect(hasSelectedOption(html, "2")).toBe(true);
      });

      test("keeps the 'Show all listings' toggle on the edit form", async () => {
        // An existing attendee always has a booked line, so the toggle stays to
        // tuck the not-booked rows away — the show-all modifier is not applied.
        const listing = await createTestListing({
          maxAttendees: 100,
          name: "Booked",
        });
        const result = await bookAttendee(listing);
        const attendeeId = result.success ? result.attendees[0]!.id : 0;
        const response = await adminGet(`/admin/attendees/${attendeeId}/edit`);
        const html = await expectHtmlResponse(
          response,
          200,
          "Show all listings",
        );
        expect(html).toContain('name="show_all"');
        expect(html).not.toContain("listing-editor show-all-listings");
      });

      test("preserves return_url as a hidden field when provided", async () => {
        await createTestListing({ maxAttendees: 100 });
        const returnUrl = "/admin/calendar";
        const response = await adminGet(
          `/admin/attendees/new?return_url=${encodeURIComponent(returnUrl)}`,
        );
        await expectHtmlResponse(response, 200, 'name="return_url"', returnUrl);
      });
    });

    describe("edit route (/admin/attendees/:id) requires auth", () => {
      // The edit GET/POST share the same session guards as /new. Assert them on
      // the edit endpoints directly so an unauthenticated request can never reach
      // (or mutate) an existing attendee. Auth is checked before the attendee is
      // loaded, so a placeholder id is fine.
      testRequiresAuth("/admin/attendees/1");
      testRequiresAuth("/admin/attendees/1", {
        body: { line_count: "1", name: "X" },
        method: "POST",
      });
    });
  },
);
