import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeLineFields,
  buildAttendeeEditForm,
  createTestAttendee,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import {
  everydayDailyListing,
  expectMixedStandardAndDailyLines,
  submitNewAttendeeForm,
  tomorrowInTz,
} from "./helpers.ts";

describeWithEnv(
  "server (unified attendee form) — overbooking & mixed timing",
  { db: true },
  () => {
    describe("admin overbooking", () => {
      test("create may overbook a full listing", async () => {
        const listing = await createTestListing({
          maxAttendees: 1,
          name: "Tiny",
        });
        await createTestAttendee(listing.id, listing.slug, "First", "f@e.com");
        // Capacity is 1 and already full; the admin adds a second anyway.
        const { response } = await adminFormPost("/admin/attendees/new", {
          name: "Second",
          ...attendeeLineFields([
            { eventId: listing.id, quantity: Number("1") },
          ]),
        });
        expect(response.status).toBe(302);
        expect((await getAttendeesRaw(listing.id)).length).toBe(2);
      });

      test("edit may overbook by raising the quantity past capacity", async () => {
        const listing = await createTestListing({
          maxAttendees: 2,
          maxQuantity: 10,
          name: "Cap2",
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "A",
          "a@e.com",
        );
        const { loadExistingLines } = await import(
          "#shared/db/attendees/atomic-update.ts"
        );
        const key = (await loadExistingLines(attendee.id))[0]!.key;
        const form = await buildAttendeeEditForm(attendee.id, {
          lines: [{ eventId: listing.id, key, quantity: 10 }],
          name: "A",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);
        expect((await getAttendeesRaw(listing.id))[0]!.quantity).toBe(10);
      });

      test("edit may overbook by adding a full listing", async () => {
        const home = await createTestListing({
          maxAttendees: 100,
          name: "Home",
        });
        const full = await createTestListing({ maxAttendees: 1, name: "Full" });
        await createTestAttendee(full.id, full.slug, "Filler", "fill@e.com");
        const attendee = await createTestAttendee(
          home.id,
          home.slug,
          "B",
          "b@e.com",
        );
        const { loadExistingLines } = await import(
          "#shared/db/attendees/atomic-update.ts"
        );
        const homeKey = (await loadExistingLines(attendee.id))[0]!.key;
        const form = await buildAttendeeEditForm(attendee.id, {
          lines: [
            { eventId: home.id, key: homeKey, quantity: 1 },
            { eventId: full.id, quantity: 1 },
          ],
          name: "B",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);
        expect((await getAttendeesRaw(full.id)).length).toBe(2);
      });

      test("warns on the form when a booking overbooks a listing", async () => {
        const listing = await createTestListing({
          maxAttendees: 1,
          name: "Solo",
        });
        await createTestAttendee(listing.id, listing.slug, "First", "f1@e.com");
        // Blank name forces an in-place re-render that surfaces the warning.
        const { response } = await adminFormPost("/admin/attendees/new", {
          name: "",
          ...attendeeLineFields([
            { eventId: listing.id, quantity: Number("1") },
          ]),
        });
        const html = await expectHtmlResponse(response, 200);
        expect(html).toContain("Solo is overbooked");
      });

      test("does not warn when an at-capacity booking is edited unchanged", async () => {
        const listing = await createTestListing({
          maxAttendees: 1,
          name: "Exact",
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Only",
          "only@e.com",
        );
        // The booking fills the listing, but it is the attendee's own row — the
        // self-excluding check means no overbooking warning.
        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        const html = await expectHtmlResponse(response, 200);
        expect(html).not.toContain("is overbooked");
      });
    });

    describe("integration: mixed single-day and multi-day on one attendee", () => {
      test("creates an attendee with both a standard and a daily line", async () => {
        const standard = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Standard Ev",
        });
        const daily = await everydayDailyListing({
          maxQuantity: 5,
          name: "Daily Ev",
        });
        const tomorrow = tomorrowInTz();

        const response = await submitNewAttendeeForm({
          day_count: "1",
          email: "mix@example.com",
          name: "Mix",
          start_date: tomorrow,
          ...attendeeLineFields([
            { eventId: standard.id, quantity: 1 },
            { eventId: daily.id, quantity: 2 },
          ]),
        });
        const dailyAttendees = await expectMixedStandardAndDailyLines(
          response,
          standard.id,
          daily.id,
          tomorrow,
        );
        expect(dailyAttendees[0]!.quantity).toBe(2);
      });

      test("edits an attendee adding a daily line alongside an existing standard one", async () => {
        const standard = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Std Ev",
        });
        const daily = await everydayDailyListing({
          maxQuantity: 5,
          name: "Daily Ev",
        });
        const attendee = await createTestAttendee(
          standard.id,
          standard.slug,
          "Edit Mix",
          "editmix@example.com",
        );
        const { loadExistingLines } = await import(
          "#shared/db/attendees/atomic-update.ts"
        );
        const existing = await loadExistingLines(attendee.id);
        const tomorrow = tomorrowInTz();

        const form = await buildAttendeeEditForm(attendee.id, {
          lines: [
            { eventId: standard.id, key: existing[0]!.key, quantity: 1 },
            { eventId: daily.id, key: "", quantity: 2 },
          ],
          name: "Edit Mix",
          startDate: tomorrow,
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        await expectMixedStandardAndDailyLines(
          response,
          standard.id,
          daily.id,
          tomorrow,
        );
      });
    });
  },
);
