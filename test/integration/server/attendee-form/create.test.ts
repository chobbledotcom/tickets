import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { oneLineAttendeeForm } from "#test/lib/server-attendee-form/_shared-setup.ts";
import {
  expectAttendeeLineCount,
  submitNewAttendeeForm,
} from "#test/lib/server-attendee-form/helpers.ts";
import { expectRedirect, testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeLineFields,
  buildAttendeeEditForm,
  createTestAttendee,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, setupListingAndLogin } from "#test-utils/session.ts";

describeWithEnv(
  "server (unified attendee form) — create & line edits",
  { db: true },
  () => {
    describe("POST /admin/attendees/new", () => {
      testRequiresAuth("/admin/attendees/new", {
        body: { line_count: "1", name: "X" },
        method: "POST",
        setup: async () => {
          await createTestListing({ maxAttendees: 100 });
        },
      });

      test("creates an attendee with one listing line", async () => {
        const { listing: event } = await setupListingAndLogin({
          maxAttendees: 100,
          maxQuantity: 5,
        });
        const response = await submitNewAttendeeForm({
          email: "jane@example.com",
          name: "Jane Doe",
          ...attendeeLineFields([{ eventId: event.id, quantity: Number("2") }]),
        });
        expectRedirect(response, "/admin/attendees/");
        const attendees = await expectAttendeeLineCount(event.id, 1);
        expect(attendees[0]!.quantity).toBe(2);
      });

      test("a no-quantity-only create persists the line and clears any balance", async () => {
        const { listing: event } = await setupListingAndLogin({
          maxAttendees: 100,
        });
        const response = await submitNewAttendeeForm({
          name: "Ghost Only",
          ...attendeeLineFields([
            { eventId: event.id, noQuantity: true, quantity: 1 },
          ]),
          remaining_balance: "20",
        });
        expectRedirect(response, "/admin/attendees/");
        const attendees = await expectAttendeeLineCount(event.id, 1);
        expect(attendees[0]!.quantity).toBe(0);
        // No real line ⇒ the unpayable balance is not stored.
        const { getAttendeeBalanceState } = await import(
          "#shared/db/attendees/balance.ts"
        );
        expect(
          (await getAttendeeBalanceState(attendees[0]!.id))!.remainingBalance,
        ).toBe(0);
      });

      test("creates an attendee with multiple listing lines in one submission", async () => {
        const event1 = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
          name: "A",
        });
        const event2 = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
          name: "B",
        });
        const response = await submitNewAttendeeForm({
          email: "multi@example.com",
          name: "Multi",
          ...attendeeLineFields([
            { eventId: event1.id, quantity: 1 },
            { eventId: event2.id, quantity: 3 },
          ]),
        });
        expect(response.status).toBe(302);
        await expectAttendeeLineCount(event1.id, 1);
        const att2 = await expectAttendeeLineCount(event2.id, 1);
        expect(att2[0]!.quantity).toBe(3);
      });

      test("fails validation when name is blank and re-renders with the rest preserved", async () => {
        const event = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
        });
        const response = await submitNewAttendeeForm(
          oneLineAttendeeForm({
            email: "preserve@example.com",
            eventId: event.id,
            name: "",
          }),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Name is required");
        expect(html).toContain("preserve@example.com");
        // No attendee was created
        await expectAttendeeLineCount(event.id, 0);
      });

      test("create books the open listing and overbooks the full one", async () => {
        const open = await createTestListing({
          maxAttendees: 100,
          name: "Open",
        });
        const full = await createTestListing({ maxAttendees: 1, name: "Full" });
        await createTestAttendee(
          full.id,
          full.slug,
          "Filler",
          "filler@example.com",
        );
        const { response } = await adminFormPost("/admin/attendees/new", {
          name: "Multi",
          ...attendeeLineFields([
            { eventId: open.id, quantity: 1 },
            { eventId: full.id, quantity: 1 },
          ]),
        });
        // Admin manual add is allowed to overbook, so both bookings are created.
        expect(response.status).toBe(302);
        await expectAttendeeLineCount(open.id, 1);
        await expectAttendeeLineCount(full.id, 2);
      });
    });

    describe("POST /admin/attendees/:id — line edits via the unified form", () => {
      test("adds a new listing line to an existing attendee", async () => {
        const event1 = await createTestListing({
          maxAttendees: 50,
          name: "E1",
        });
        const event2 = await createTestListing({
          maxAttendees: 50,
          name: "E2",
        });
        const attendee = await createTestAttendee(
          event1.id,
          event1.slug,
          "Link",
          "link@example.com",
        );
        // Load the existing line key for event1
        const { loadExistingLines } = await import(
          "#shared/db/attendees/atomic-update.ts"
        );
        const existing = await loadExistingLines(attendee.id);
        const form = await buildAttendeeEditForm(attendee.id, {
          lines: [
            { eventId: event1.id, key: existing[0]!.key, quantity: 1 },
            { eventId: event2.id, key: "", quantity: 1 },
          ],
          name: "Link",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);
        await expectAttendeeLineCount(event1.id, 1);
        await expectAttendeeLineCount(event2.id, 1);
      });

      test("removes an existing listing line via the unified form", async () => {
        const event1 = await createTestListing({
          maxAttendees: 50,
          name: "E1",
        });
        const event2 = await createTestListing({
          maxAttendees: 50,
          name: "E2",
        });
        const { attendeesApi } = await import("#shared/db/attendees/api.ts");
        const result = await attendeesApi.createAttendeeAtomic({
          bookings: [
            { listingId: event1.id, quantity: 1 },
            {
              listingId: event2.id,
              quantity: 1,
            },
          ],
          email: "",
          name: "Multi",
        });
        if (!result.success) throw new Error("setup");
        const attendeeId = result.attendees[0]!.id;
        const { loadExistingLines } = await import(
          "#shared/db/attendees/atomic-update.ts"
        );
        const existing = await loadExistingLines(attendeeId);
        const event1Key = existing.find(
          (e) => e.booking.listing_id === event1.id,
        )!.key;
        // Submit only event1 — event2 should be removed
        const form = await buildAttendeeEditForm(attendeeId, {
          lines: [{ eventId: event1.id, key: event1Key, quantity: 1 }],
          name: "Multi",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendeeId}`,
          form,
        );
        expect(response.status).toBe(302);
        await expectAttendeeLineCount(event1.id, 1);
        await expectAttendeeLineCount(event2.id, 0);
      });

      test("updates quantity on an existing line via the unified form", async () => {
        const event = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Qty",
        });
        const attendee = await createTestAttendee(
          event.id,
          event.slug,
          "Qty",
          "qty@example.com",
        );
        const { loadExistingLines } = await import(
          "#shared/db/attendees/atomic-update.ts"
        );
        const existing = await loadExistingLines(attendee.id);
        const form = await buildAttendeeEditForm(attendee.id, {
          lines: [{ eventId: event.id, key: existing[0]!.key, quantity: 4 }],
          name: "Qty",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);
        expect((await getAttendeesRaw(event.id))[0]!.quantity).toBe(4);
      });
    });
  },
);
