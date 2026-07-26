import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { oneLineAttendeeForm } from "#test/test-utils/attendee-form/_shared-setup.ts";
import { attendeeWithNoBookings } from "#test/test-utils/attendee-form/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeLineFields,
  buildAttendeeEditForm,
  createTestAttendee,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "server (unified attendee form) — error paths",
  { db: true },
  () => {
    describe("error paths and edge cases", () => {
      test("create re-renders with an error when no listing line is filled in", async () => {
        await createTestListing({ maxAttendees: 100 });
        const { response } = await adminFormPost("/admin/attendees/new", {
          name: "No Lines",
        });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Book at least one listing");
        expect(html).toContain("No Lines");
      });

      test("create re-renders with error when atomic create fails with capacity_exceeded", async () => {
        const event = await createTestListing({ maxAttendees: 100 });
        await withMocks(
          () =>
            stub(attendeesApi, "createAttendeeAtomic", () =>
              Promise.resolve({
                reason: "capacity_exceeded" as const,
                success: false,
              }),
            ),
          async () => {
            const { response } = await adminFormPost("/admin/attendees/new", {
              name: "Cap",
              ...attendeeLineFields([
                { eventId: event.id, quantity: Number("1") },
              ]),
            });
            expect(response.status).toBe(200);
            expect(await response.text()).toContain("spots");
          },
        );
      });

      test("treats a non-numeric quantity as not booked", async () => {
        const event = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 2,
        });
        const { response } = await adminFormPost("/admin/attendees/new", {
          name: "Valid",
          ...attendeeLineFields([
            { eventId: event.id, quantity: Number("abc") },
          ]),
        });
        // "abc" parses to no quantity, so nothing is booked.
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Book at least one listing");
        expect((await getAttendeesRaw(event.id)).length).toBe(0);
      });

      test("create re-renders with line-level error only (no attendee error)", async () => {
        const event = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 2,
        });
        const { response } = await adminFormPost("/admin/attendees/new", {
          name: "Valid Name",
          ...attendeeLineFields([{ eventId: event.id, quantity: Number("5") }]),
        });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Quantity must be at most 2");
        expect(html).toContain("Valid Name");
      });

      test("create rejects a malformed email and saves nothing", async () => {
        const event = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
        });
        const { response } = await adminFormPost(
          "/admin/attendees/new",
          oneLineAttendeeForm({
            email: "not-an-email",
            eventId: event.id,
            name: "Valid Name",
          }),
        );
        // Re-renders in place (200) with the field error; the browser's
        // type=email guard is bypassed by a no-JS / crafted POST, so the server
        // is the only thing standing between bad data and the PII blob.
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Please enter a valid email address");
        expect(html).toContain("Valid Name");
        expect((await getAttendeesRaw(event.id)).length).toBe(0);
      });

      test("create requires a start date for a booked daily listing", async () => {
        const daily = await createDailyTestListing({
          name: "Daily Needs Date",
        });
        const { response } = await adminFormPost("/admin/attendees/new", {
          name: "Dateless",
          ...attendeeLineFields([{ eventId: daily.id, quantity: Number("1") }]),
        });
        // The shared start date is missing, so the daily booking can't be saved.
        expect(response.status).toBe(200);
        const html = await response.text();
        // The date error is a focusable alert (autofocus + tabindex), so the
        // browser scrolls straight to it instead of leaving the operator at the
        // top of the page — no JavaScript involved.
        expect(html).toContain(
          `<div autofocus class="error" role="alert" tabindex="-1">A start date is required`,
        );
        // The name field gives up its default autofocus so it doesn't win the
        // focus race over the (lower) date error.
        expect(html).toContain(`autocomplete="off" id="name"`);
        expect(html).not.toContain(`autocomplete="off" autofocus id="name"`);
        expect((await getAttendeesRaw(daily.id)).length).toBe(0);
      });

      test("edit that un-books every listing re-renders with the no-lines error", async () => {
        const event = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          event.id,
          event.slug,
          "Blank",
          "blank@example.com",
        );
        // Set the only booked listing to quantity 0 — nothing remains booked.
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          {
            name: "Blank",
            ...attendeeLineFields([
              { eventId: event.id, quantity: Number("0") },
            ]),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Book at least one listing");
        // The existing booking is untouched (no_lines short-circuits the diff).
        expect((await getAttendeesRaw(event.id)).length).toBe(1);
      });

      test("edit re-renders preserving data when capacity is exceeded", async () => {
        const event = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          event.id,
          event.slug,
          "Cap",
          "cap@example.com",
        );
        await withMocks(
          () =>
            stub(attendeesApi, "applyAttendeeAtomicEdit", () =>
              Promise.resolve({
                listingIds: [event.id],
                reason: "capacity_exceeded" as const,
                success: false,
              }),
            ),
          async () => {
            const form = await buildAttendeeEditForm(attendee.id, {
              name: "Cap Edited",
            });
            const { response } = await adminFormPost(
              `/admin/attendees/${attendee.id}`,
              form,
            );
            // Re-render in place (200), keeping the operator's edits, with a
            // page-level explanation that nothing was saved.
            expect(response.status).toBe(200);
            const html = await response.text();
            expect(html).toContain("nothing was saved");
            expect(html).toContain("Cap Edited");
          },
        );
      });

      test("GET edit page for attendee with no bookings renders with no questions", async () => {
        const attendee = await attendeeWithNoBookings("Orphan");
        const response = await adminGet(`/admin/attendees/${attendee.id}`);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Attendee: Orphan");
      });

      test("POST edit for attendee with no bookings re-renders with no_lines error", async () => {
        const attendee = await attendeeWithNoBookings("Orphan");
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          { name: "Orphan" },
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Book at least one listing");
      });
    });
  },
);
