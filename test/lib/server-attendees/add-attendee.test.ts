// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { settings } from "#shared/db/settings.ts";
import {
  assertAdminHtml,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv, rawListingRange } from "#test-utils/db.ts";
import {
  createTestAttendee,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
} from "#test-utils/session.ts";

// jscpd:ignore-end
import {
  expectAttendeeAdded,
  expectFlashPage,
  submitAddAttendee,
} from "./helpers.ts";

describeWithEnv("server (admin attendees) > add attendee", { db: true }, () => {
  describe("POST /admin/listing/:listingId/attendee (add attendee)", () => {
    testRequiresAuth("/admin/listing/1/attendee", {
      body: {
        email: "jane@example.com",
        name: "Jane Doe",
        quantity: "1",
      },
      method: "POST",
      setup: async () => {
        await createTestListing({ maxAttendees: 100 });
      },
    });

    test("rejects invalid CSRF token", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
      });

      const response = await submitAddAttendee(
        listing.id,
        cookie,
        "invalid-token",
        {
          email: "jane@example.com",
          name: "Jane Doe",
          quantity: "1",
        },
      );
      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/listing/999/attendee", {
        email: "jane@example.com",
        name: "Jane Doe",
        quantity: "1",
      });
      expect(response.status).toBe(404);
    });

    test("adds attendee to email listing", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        fields: "email",
        maxAttendees: 100,
      });

      const response = await submitAddAttendee(listing.id, cookie, csrfToken, {
        email: "jane@example.com",
        name: "Jane Doe",
        quantity: "1",
      });
      expectRedirect(response, `/admin/listing/${listing.id}`);
      expectFlash(response, expect.stringContaining("Added"));

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);

      // The manual add is recorded in the listing activity log, naming the
      // attendee.
      const { getListingActivityLog } = await import(
        "#test-utils/activity-log.ts"
      );
      const log = (await getListingActivityLog(listing.id)).find((l) =>
        l.message.includes("added manually"),
      );
      expect(log?.message).toContain("Jane Doe");
    });

    test("persists every submitted contact field, not just the name", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        fields: "email,phone,address,special_instructions",
        maxAttendees: 100,
      });

      const response = await submitAddAttendee(listing.id, cookie, csrfToken, {
        address: "9 Persistence Way",
        email: "persist@example.com",
        name: "Persist Person",
        phone: "555-7777",
        quantity: "1",
        special_instructions: "Aisle seat",
      });
      expect(response.status).toBe(302);

      // Each contact field round-trips to the edit form; a field dropped to ""
      // on the way in would be missing here.
      const [added] = await getAttendeesRaw(listing.id);
      const edit = await adminGet(`/admin/attendees/${added!.id}/edit`);
      await expectHtmlResponse(
        edit,
        200,
        "Persist Person",
        "persist@example.com",
        "555-7777",
        "9 Persistence Way",
        "Aisle seat",
      );
    });

    test("pre-fills the postcode search box from an address ending in a postcode", async () => {
      settings.setForTest({
        address_lookup_api_key: "test-api-key",
        address_lookup_provider: "easypostcodes",
      });
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        fields: "address",
        maxAttendees: 100,
      });

      const response = await submitAddAttendee(listing.id, cookie, csrfToken, {
        address: "1 High Street, London, SW1A 1AA",
        name: "Postcode Person",
        quantity: "1",
      });
      expect(response.status).toBe(302);

      const [added] = await getAttendeesRaw(listing.id);
      const edit = await adminGet(`/admin/attendees/${added!.id}/edit`);
      const html = await edit.text();
      // The lookup panel's search box starts filled with the saved postcode.
      expect(html).toContain(
        'data-address-search type="text" value="SW1A 1AA"',
      );
    });

    test("adds a customisable daily attendee spanning the chosen day count", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        customisableDays: true,
        dayPrices: { 1: 0, 2: 0, 3: 0 },
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 100,
      });

      const response = await submitAddAttendee(listing.id, cookie, csrfToken, {
        date: "2026-09-10",
        day_count: "2",
        email: "jane@example.com",
        name: "Jane Doe",
        quantity: "1",
      });
      expectRedirect(response, `/admin/listing/${listing.id}`);

      // The booking reserves the admin's chosen 2 days (10th–11th), not the
      // listing's maximum of 3.
      const range = await rawListingRange(listing.id);
      expect(range!.start_at).toBe("2026-09-10T00:00:00Z");
      expect(range!.end_at).toBe("2026-09-12T00:00:00.000Z");
    });

    test("adds attendee to phone listing", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        fields: "phone",
        maxAttendees: 100,
      });

      const response = await submitAddAttendee(listing.id, cookie, csrfToken, {
        name: "Phone User",
        phone: "+1234567890",
        quantity: "1",
      });
      await expectAttendeeAdded(response, listing.id);
    });

    test("adds attendee to both listing", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        fields: "email,phone",
        maxAttendees: 100,
      });

      const response = await submitAddAttendee(listing.id, cookie, csrfToken, {
        email: "both@example.com",
        name: "Both User",
        phone: "+1234567890",
        quantity: "2",
      });
      const added = await expectAttendeeAdded(response, listing.id);
      expect(added.quantity).toBe(2);
    });

    test("redirects with error on validation failure", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 100,
      });

      const response = await submitAddAttendee(listing.id, cookie, csrfToken, {
        email: "",
        name: "",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      // Empty name is the first required field to fail, so the flash names it.
      expectFlash(response, "Your Name is required", false);
    });

    test("redirects with error when capacity exceeded", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "First",
        "first@example.com",
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/attendee`,
        {
          email: "second@example.com",
          name: "Second",
          quantity: "1",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("spots"), false);
    });

    test("redirects with error on encryption failure", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 100,
      });

      await withMocks(
        () =>
          stub(attendeesApi, "createAttendeeAtomic", () =>
            Promise.resolve({
              reason: "encryption_error",
              success: false,
            }),
          ),
        async () => {
          const errorSpy = spy(console, "error");
          try {
            const response = await submitAddAttendee(
              listing.id,
              cookie,
              csrfToken,
              {
                email: "enc@example.com",
                name: "Enc Fail",
                quantity: "1",
              },
            );
            expect(response.status).toBe(302);
            expectFlash(response, expect.stringContaining("Encryption"), false);
            // An encryption failure (and only that reason) is logged to the
            // error log — a capacity failure is a normal outcome and isn't.
            const logged = errorSpy.calls.map((c) => String(c.args[0]));
            expect(logged.some((s) => s.includes("manual add attendee"))).toBe(
              true,
            );
          } finally {
            errorSpy.restore();
          }
        },
      );
    });

    test("adds attendee to daily listing with date", async () => {
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      const futureDate = addDays(todayInTz("UTC"), 7);

      const { listing, cookie, csrfToken } = await setupListingAndLogin({
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
        maxAttendees: 100,
      });

      const response = await submitAddAttendee(listing.id, cookie, csrfToken, {
        date: futureDate,
        email: "daily@example.com",
        name: "Daily User",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Added"));

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.date).toBe(futureDate);
    });

    test("roster tab shows add attendee form", async () => {
      const { listing } = await setupListingAndLogin({ maxAttendees: 100 });

      await assertAdminHtml(
        `/admin/listing/${listing.id}/attendees`,
        "Add Attendee",
        `/admin/listing/${listing.id}/attendee`,
        "Your Name",
        "Quantity",
      );
    });

    test("listing page shows success message when flash cookie present", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
      });
      await expectFlashPage(
        `/admin/listing/${listing.id}`,
        cookie,
        "Added Jane Doe",
      );
    });

    test("listing page shows error message when flash cookie present", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
      });
      await expectFlashPage(
        `/admin/listing/${listing.id}`,
        cookie,
        "Not enough spots",
        false,
      );
    });
  });
});
