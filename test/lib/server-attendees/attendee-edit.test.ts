// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  bookAttendee,
  buildAttendeeEditForm,
  createTestAttendee,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  FLASH_TEST_ID,
  flashCookieHeader,
  mockFormRequest,
  setupListingAndLogin,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

// jscpd:ignore-end
describeWithEnv(
  "server (admin attendees) > attendee edit",
  { db: true },
  () => {
    describe("POST /admin/attendees/:attendeeId", () => {
      testRequiresAuth("/admin/attendees/1", {
        body: {
          address: "",
          email: "jane@example.com",
          line_count: "1",
          line_event_id_0: "1",
          line_key_0: "",
          line_quantity_0: "1",
          name: "Jane Doe",
          phone: "",
          special_instructions: "",
        },
        method: "POST",
        setup: async () => {
          const listing = await createTestListing({ maxAttendees: 100 });
          await createTestAttendee(
            listing.id,
            listing.slug,
            "John Doe",
            "john@example.com",
          );
        },
      });

      test("returns 404 for non-existent attendee", async () => {
        const { response } = await adminFormPost("/admin/attendees/999", {
          address: "",
          email: "jane@example.com",
          line_count: "1",
          line_event_id_0: "1",
          line_quantity_0: "1",
          name: "Jane Doe",
          phone: "",
          special_instructions: "",
        });
        expect(response.status).toBe(404);
      });

      test("rejects invalid CSRF token", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const response = await handleRequest(
          mockFormRequest(
            `/admin/attendees/${attendee.id}`,
            {
              address: "",
              csrf_token: "invalid-token",
              email: "jane@example.com",
              line_count: "1",
              line_event_id_0: String(listing.id),
              line_quantity_0: "1",
              name: "Jane Doe",
              phone: "",
              special_instructions: "",
            },
            await testCookie(),
          ),
        );
        await expectHtmlResponse(response, 403, "Invalid CSRF token");
      });

      test("rejects empty name", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const form = await buildAttendeeEditForm(attendee.id, { name: "" });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        // Validation failure re-renders the form (200) with the error inline.
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Name is required");
      });

      test("preserves return_url on edit validation error", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const returnUrl = "/admin/calendar#attendees";

        const form = await buildAttendeeEditForm(attendee.id, {
          name: "",
          returnUrl,
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Name is required");
        expect(html).toContain(returnUrl);
      });

      test("rejects whitespace-only name", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const form = await buildAttendeeEditForm(attendee.id, { name: "   " });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Name is required");
      });

      test("updates attendee with new data", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const form = await buildAttendeeEditForm(attendee.id, {
          address: "456 Oak Ave",
          email: "jane@example.com",
          name: "Jane Doe",
          phone: "555-9999",
          special_instructions: "Wheelchair access",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/attendees/${attendee.id}/edit?form=attendee-form#attendee-form`,
          "Updated Jane Doe",
        )(response);

        // Verify the edit form shows the updated data
        const editResponse = await adminGet(
          `/admin/attendees/${attendee.id}/edit`,
        );
        expect(editResponse.status).toBe(200);
        const html = await editResponse.text();
        expect(html).toContain("Jane Doe");
        expect(html).toContain("jane@example.com");
        expect(html).toContain("555-9999");
        expect(html).toContain("456 Oak Ave");
        expect(html).toContain("Wheelchair access");
      });

      test("editing an unrelated field keeps every path of a dual-path booking", async () => {
        // The attendee books the listing through a package AND its own row.
        // The editor renders one line per ROW, so a rename must round-trip
        // both lines and keep each path's quantity untouched.
        const listing = await createTestListing({
          maxAttendees: 10,
          maxQuantity: 5,
        });
        const { createTestGroup } = await import("#test-utils");
        const group = await createTestGroup({
          isPackage: true,
          name: "EditKit",
        });
        const { createAttendeeAtomic } = await import(
          "#shared/db/attendees.ts"
        );
        const made = await createAttendeeAtomic({
          bookings: [
            { listingId: listing.id, packageGroupId: group.id, quantity: 2 },
            { listingId: listing.id, quantity: 1 },
          ],
          email: "dual-edit@example.com",
          name: "Dual Edit",
        });
        expect(made.success).toBe(true);
        const attendee = (made as Extract<typeof made, { success: true }>)
          .attendees[0]!;

        const form = await buildAttendeeEditForm(attendee.id, {
          name: "Dual Edit Renamed",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);

        const { queryAll } = await import("#shared/db/client.ts");
        const rows = await queryAll<{
          package_group_id: number;
          quantity: number;
        }>(
          `SELECT package_group_id, quantity FROM listing_attendees
          WHERE attendee_id = ? ORDER BY package_group_id ASC`,
          [attendee.id],
        );
        expect(
          rows.map((row) => [Number(row.package_group_id), row.quantity]),
        ).toEqual([
          [0, 1],
          [group.id, 2],
        ]);
      });

      test("returns to the edit form after edit, preserving return_url", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const returnUrl = "/admin/calendar?date=2026-03-15#attendees";

        const form = await buildAttendeeEditForm(attendee.id, {
          email: "john@example.com",
          name: "John Doe",
          returnUrl,
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        // Save returns to the same form (anchored), carrying return_url through
        // so a later save still round-trips the caller's origin.
        expectRedirect(
          response,
          `/admin/attendees/${attendee.id}`,
          `return_url=${encodeURIComponent(returnUrl)}`,
          "#attendee-form",
        );
        expectFlash(response, expect.stringContaining("John Doe"));
      });

      test("updates attendee PII via edit form", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          name: "Listing 1",
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const form = await buildAttendeeEditForm(attendee.id, {
          email: "jane@example.com",
          name: "Jane Smith",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/attendees/${attendee.id}/edit?form=attendee-form#attendee-form`,
          "Updated Jane Smith",
        )(response);
      });

      test("preserves quantity when editing contact info without quantity field", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
        });
        const { attendee } = await createTestAttendeeDirect(
          listing.id,
          "John Doe",
          "john@example.com",
          3,
        );
        const form = await buildAttendeeEditForm(attendee.id, {
          email: "jane@example.com",
          name: "Jane Doe",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);

        const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
        const updated = await getAttendeeRaw(attendee.id);
        expect(updated!.quantity).toBe(3);
      });

      test("listing page shows edit success message", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
        });

        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}?flash=${FLASH_TEST_ID}`,
          {
            cookie: `${cookie}; ${flashCookieHeader("Updated Jane Doe")}`,
          },
        );
        await expectHtmlResponse(response, 200, "Updated Jane Doe");
      });

      test("attendee table shows edit link", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const response = await adminGet(
          `/admin/listing/${listing.id}/attendees`,
        );
        await expectHtmlResponse(
          response,
          200,
          `/admin/attendees/${attendee.id}`,
          "Edit",
        );
      });

      test("shows current listing in registrations and active listings in add-to-listing", async () => {
        const listing1 = await createTestListing({
          active: true,
          maxAttendees: 100,
          name: "Listing 1",
        });
        await createTestListing({
          active: true,
          maxAttendees: 100,
          name: "Listing 2",
        });
        const result = await bookAttendee(listing1, {
          email: "john@example.com",
          name: "John Doe",
          quantity: 1,
        });
        if (!result.success) throw new Error("Failed to create attendee");
        const attendee = result.attendees[0]!;

        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, "Listing 1", "Listing 2");
      });

      test("shows edit form with empty email field", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const result = await bookAttendee(listing, {
          email: "",
          name: "John Doe",
          quantity: 1,
        });
        if (!result.success) throw new Error("Failed to create attendee");
        const attendee = result.attendees[0]!;

        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, 'type="email"', 'name="email"');
      });

      test("shows inactive listing in registrations table", async () => {
        const inactiveListing = await createTestListing({
          maxAttendees: 100,
          name: "Inactive Listing",
        });

        const result = await bookAttendee(inactiveListing, {
          email: "john@example.com",
          name: "John Doe",
          quantity: 1,
        });
        if (!result.success) throw new Error("Failed to create attendee");
        const attendee = result.attendees[0]!;

        // Manually set listing to inactive after creating attendee
        const { getDb } = await import("#shared/db/client.ts");
        await getDb().execute({
          args: [inactiveListing.id],
          sql: "UPDATE listings SET active = 0 WHERE id = ?",
        });

        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        // Listing still shows in registrations table even when inactive
        await expectHtmlResponse(
          response,
          200,
          "Inactive Listing",
          "Listing Registrations",
        );
      });

      test("updates attendee with empty email", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const result = await bookAttendee(listing, {
          email: "john@example.com",
          name: "John Doe",
          quantity: 1,
        });
        if (!result.success) throw new Error("Failed to create attendee");
        const attendee = result.attendees[0]!;

        const form = await buildAttendeeEditForm(attendee.id, {
          email: "",
          name: "John Doe",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);
      });

      test("updates attendee with all non-empty fields", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const result = await bookAttendee(listing, {
          address: "123 Main St",
          email: "john@example.com",
          name: "John Doe",
          phone: "555-1234",
          quantity: 1,
          special_instructions: "VIP",
        });
        if (!result.success) throw new Error("Failed to create attendee");
        const attendee = result.attendees[0]!;

        const form = await buildAttendeeEditForm(attendee.id, {
          address: "456 Oak Ave",
          email: "jane@example.com",
          name: "Jane Smith",
          phone: "555-9999",
          special_instructions: "Special access needed",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/attendees/${attendee.id}/edit?form=attendee-form#attendee-form`,
          "Updated Jane Smith",
        )(response);
      });

      test("shows quantity field on edit form", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          maxQuantity: 5,
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, 'name="qty_');
      });
    });
  },
);
