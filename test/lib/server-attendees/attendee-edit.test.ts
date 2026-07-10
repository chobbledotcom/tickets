// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
  testCookie,
} from "#test-utils/session.ts";

// jscpd:ignore-end
import {
  createDualPackageAttendee,
  dualPackageRows,
  expectFlashPage,
  firstAttendee,
  setupListingAndAttendee,
  submitAttendeeEdit,
} from "./helpers.ts";

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
          await setupListingAndAttendee();
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
        const { listing, attendee } = await setupListingAndAttendee();
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
        const { attendee } = await setupListingAndAttendee();
        const response = await submitAttendeeEdit(attendee.id, {
          name: "",
        });
        // Validation failure re-renders the form (200) with the error inline.
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Name is required");
      });

      test("preserves return_url on edit validation error", async () => {
        const { attendee } = await setupListingAndAttendee();
        const returnUrl = "/admin/calendar#attendees";

        const response = await submitAttendeeEdit(attendee.id, {
          name: "",
          returnUrl,
        });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Name is required");
        expect(html).toContain(returnUrl);
      });

      test("rejects whitespace-only name", async () => {
        const { attendee } = await setupListingAndAttendee();
        const response = await submitAttendeeEdit(attendee.id, {
          name: "   ",
        });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Name is required");
      });

      test("updates attendee with new data", async () => {
        const { attendee } = await setupListingAndAttendee();
        const response = await submitAttendeeEdit(attendee.id, {
          address: "456 Oak Ave",
          email: "jane@example.com",
          name: "Jane Doe",
          phone: "555-9999",
          special_instructions: "Wheelchair access",
        });
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
        const { createTestGroup } = await import(
          "#test-utils/db-helpers/groups.ts"
        );
        const group = await createTestGroup({
          isPackage: true,
          name: "EditKit",
        });
        const attendee = await createDualPackageAttendee(
          listing.id,
          group.id,
          "Dual Edit",
          "dual-edit@example.com",
        );

        const response = await submitAttendeeEdit(attendee.id, {
          name: "Dual Edit Renamed",
        });
        expect(response.status).toBe(302);

        expect(await dualPackageRows(attendee.id)).toEqual([
          [0, 1],
          [group.id, 2],
        ]);
      });

      test("returns to the edit form after edit, preserving return_url", async () => {
        const { attendee } = await setupListingAndAttendee();
        const returnUrl = "/admin/calendar?date=2026-03-15#attendees";

        const response = await submitAttendeeEdit(attendee.id, {
          email: "john@example.com",
          name: "John Doe",
          returnUrl,
        });
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
        const { attendee } = await setupListingAndAttendee({
          listing: { maxAttendees: 100, name: "Listing 1" },
        });
        const response = await submitAttendeeEdit(attendee.id, {
          email: "jane@example.com",
          name: "Jane Smith",
        });
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
        const response = await submitAttendeeEdit(attendee.id, {
          email: "jane@example.com",
          name: "Jane Doe",
        });
        expect(response.status).toBe(302);

        const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
        const updated = await getAttendeeRaw(attendee.id);
        expect(updated!.quantity).toBe(3);
      });

      test("listing page shows edit success message", async () => {
        const { listing, cookie } = await setupListingAndLogin({
          maxAttendees: 100,
        });
        await expectFlashPage(
          `/admin/listing/${listing.id}`,
          cookie,
          "Updated Jane Doe",
        );
      });

      test("attendee table shows edit link", async () => {
        const { listing, attendee } = await setupListingAndAttendee();
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
        const attendee = firstAttendee(
          await bookAttendee(listing1, {
            email: "john@example.com",
            name: "John Doe",
            quantity: 1,
          }),
        );

        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, "Listing 1", "Listing 2");
      });

      test("shows edit form with empty email field", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = firstAttendee(
          await bookAttendee(listing, {
            email: "",
            name: "John Doe",
            quantity: 1,
          }),
        );

        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, 'type="email"', 'name="email"');
      });

      test("shows inactive listing in registrations table", async () => {
        const inactiveListing = await createTestListing({
          maxAttendees: 100,
          name: "Inactive Listing",
        });

        const attendee = firstAttendee(
          await bookAttendee(inactiveListing, {
            email: "john@example.com",
            name: "John Doe",
            quantity: 1,
          }),
        );

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
        const attendee = firstAttendee(
          await bookAttendee(listing, {
            email: "john@example.com",
            name: "John Doe",
            quantity: 1,
          }),
        );

        const response = await submitAttendeeEdit(attendee.id, {
          email: "",
          name: "John Doe",
        });
        expect(response.status).toBe(302);
      });

      test("updates attendee with all non-empty fields", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = firstAttendee(
          await bookAttendee(listing, {
            address: "123 Main St",
            email: "john@example.com",
            name: "John Doe",
            phone: "555-1234",
            quantity: 1,
            special_instructions: "VIP",
          }),
        );

        const response = await submitAttendeeEdit(attendee.id, {
          address: "456 Oak Ave",
          email: "jane@example.com",
          name: "Jane Smith",
          phone: "555-9999",
          special_instructions: "Special access needed",
        });
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/attendees/${attendee.id}/edit?form=attendee-form#attendee-form`,
          "Updated Jane Smith",
        )(response);
      });

      test("shows quantity field on edit form", async () => {
        const { attendee } = await setupListingAndAttendee({
          listing: { maxAttendees: 100, maxQuantity: 5 },
        });
        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, 'name="qty_');
      });

      test("firstAttendee throws on a failed booking result, surfacing the reason", () => {
        expect(() =>
          firstAttendee({ reason: "encryption_error", success: false }),
        ).toThrow("Failed to create attendee: encryption_error");
      });
    });
  },
);
