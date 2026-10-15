import { assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectManualAddWebhook,
  stubWebhookFetch,
} from "#test/shared/webhook/helpers.ts";
import {
  activityMessages,
  getListingActivityLog,
} from "#test-utils/activity-log.ts";
import { expectRedirect, testRequiresAuth } from "#test-utils/assertions.ts";
import { oneLineAttendeeForm } from "#test-utils/attendee-form/_shared-setup.ts";
import { expectAttendeeLineCount } from "#test-utils/attendee-form/helpers.ts";
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
        const { response } = await adminFormPost("/admin/attendees/new", {
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
        const { response } = await adminFormPost("/admin/attendees/new", {
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
          "#db/attendees/balance.ts"
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
        const { response } = await adminFormPost("/admin/attendees/new", {
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
        const { response } = await adminFormPost(
          "/admin/attendees/new",
          oneLineAttendeeForm({
            email: "preserve@example.com",
            eventId: event.id,
            name: "",
          }),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        assertStringIncludes(html, "Name is required");
        assertStringIncludes(html, "preserve@example.com");
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
          "#db/attendees/atomic-update.ts"
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
        const { attendeesApi } = await import("#db/attendees/api.ts");
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
          "#db/attendees/atomic-update.ts"
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
          "#db/attendees/atomic-update.ts"
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

    describe("outgoing webhooks", () => {
      const fetchSpy = stubWebhookFetch();

      test("an admin create fires one webhook call and no email", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          maxQuantity: 5,
          unitPrice: 2500,
          webhookUrl: "https://hooks.example.test/registration",
        });
        const { response } = await adminFormPost("/admin/attendees/new", {
          email: "hooked@example.com",
          name: "Hooked Admin Add",
          ...attendeeLineFields([{ eventId: listing.id, quantity: 2 }]),
        });
        expectRedirect(response, "/admin/attendees/");
        expectManualAddWebhook(fetchSpy, {
          amountOwed: 5000,
          contact: { email: "hooked@example.com", name: "Hooked Admin Add" },
          listing,
          quantity: 2,
          unitPrice: 2500,
          url: "https://hooks.example.test/registration",
        });
      });

      test("a multi-line create sends the combined balance as amount_owed", async () => {
        const one = await createTestListing({
          maxAttendees: 100,
          name: "Combined One",
          unitPrice: 2500,
          webhookUrl: "https://hooks.example.test/combined",
        });
        const two = await createTestListing({
          maxQuantity: 5,
          name: "Combined Two",
          unitPrice: 1000,
        });
        const { response } = await adminFormPost("/admin/attendees/new", {
          email: "combined@example.com",
          name: "Combined Add",
          ...attendeeLineFields([
            { eventId: one.id, quantity: 1 },
            { eventId: two.id, quantity: 2 },
          ]),
        });
        expectRedirect(response, "/admin/attendees/");
        // 2500 x 1 + 1000 x 2: one consolidated payload carries the order's
        // combined outstanding balance, never one line's share of it.
        expect(fetchSpy.calls.length).toBe(1);
        const payload = fetchSpy.firstBody();
        expect(payload.amount_owed).toBe(4500);
        expect(
          payload.tickets.map((ticket) => [
            ticket.listing_slug,
            ticket.quantity,
            ticket.unit_price,
          ]),
        ).toEqual([
          [one.slug, 1, 2500],
          [two.slug, 2, 1000],
        ]);
      });

      test("a no-quantity-only create books nothing, so it fires no webhook", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          webhookUrl: "https://hooks.example.test/ghost",
        });
        const { response } = await adminFormPost("/admin/attendees/new", {
          name: "Ghost Only",
          ...attendeeLineFields([
            { eventId: listing.id, noQuantity: true, quantity: 1 },
          ]),
        });
        expectRedirect(response, "/admin/attendees/");
        await expectAttendeeLineCount(listing.id, 1);
        expect(fetchSpy.calls.length).toBe(0);
      });

      test("an edit fires no webhook", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 50,
          webhookUrl: "https://hooks.example.test/edit",
        });
        const { attendeesApi } = await import("#db/attendees/api.ts");
        const result = await attendeesApi.createAttendeeAtomic({
          bookings: [{ listingId: listing.id, quantity: 1 }],
          email: "",
          name: "Edited",
        });
        if (!result.success) throw new Error("setup");
        const attendeeId = result.attendees[0]!.id;
        const form = await buildAttendeeEditForm(attendeeId, {
          name: "Edited Two",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendeeId}`,
          form,
        );
        expect(response.status).toBe(302);
        expect(fetchSpy.calls.length).toBe(0);
      });

      test("a failed webhook still saves the attendee", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          webhookUrl: "https://hooks.example.test/failing",
        });
        fetchSpy.reply(new Response("", { status: 500 }));
        const { response } = await adminFormPost("/admin/attendees/new", {
          email: "failing@example.com",
          name: "Failing Hook",
          ...attendeeLineFields([{ eventId: listing.id, quantity: 1 }]),
        });
        expectRedirect(response, "/admin/attendees/");
        const attendees = await expectAttendeeLineCount(listing.id, 1);
        expect(attendees[0]!.quantity).toBe(1);
        // The create line stays the only create line, and the failed send
        // leaves the same operator signal the online booking path logs.
        expect(
          (await getListingActivityLog(listing.id))
            .map(({ message }) => message)
            .filter((message) => message.includes("added manually")),
        ).toEqual(["Attendee 'Failing Hook' added manually"]);
        assertArrayIncludes((await activityMessages()) ?? [], [
          "Registration notification delivery failed.",
        ]);
      });

      test("a thrown webhook delivery still saves the attendee", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          webhookUrl: "https://hooks.example.test/thrown",
        });
        fetchSpy.reply(new Error("connection reset"));
        const { response } = await adminFormPost("/admin/attendees/new", {
          email: "thrown@example.com",
          name: "Thrown Hook",
          ...attendeeLineFields([{ eventId: listing.id, quantity: 1 }]),
        });
        expectRedirect(response, "/admin/attendees/");
        await expectAttendeeLineCount(listing.id, 1);
        assertArrayIncludes((await activityMessages()) ?? [], [
          "Registration notification delivery failed.",
        ]);
      });
    });
  },
);
