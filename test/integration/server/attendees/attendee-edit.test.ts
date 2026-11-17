import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sql } from "#db/sql.ts";
import { handleRequest } from "#routes";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectIncludesAll,
  expectRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { expectEditPageRegistrations } from "#test-utils/attendees/edit-page.ts";
import {
  createDualPackageAttendee,
  dualPackageRows,
  expectFlashPage,
  firstAttendee,
  setupListingAndAttendee,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createTestAttendeeDirect,
  submitAttendeeEdit,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import type { BookAttendeeOpts } from "#test-utils/internal.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
  testCookie,
} from "#test-utils/session.ts";
import type { Attendee, ListingWithCount } from "#types";

describeWithEnv(
  "server (admin attendees) > attendee edit",
  { db: true },
  () => {
    describe("POST /admin/attendees/:attendeeId", () => {
      /** Book one attendee into a fresh listing, so a test has a row to edit.
       *  `booking` sets who the attendee is; `listing` tunes the seats of the
       *  listing it books. */
      const bookIntoNewListing = async (
        booking: BookAttendeeOpts,
        listing: TestListingOverrides = {},
      ): Promise<{ attendee: Attendee; listing: ListingWithCount }> => {
        const created = await createTestListing({
          maxAttendees: 100,
          ...listing,
        });
        return {
          attendee: firstAttendee(await bookAttendee(created, booking)),
          listing: created,
        };
      };

      /** Submit an edit form and assert the save redirects to the same form,
       *  naming the attendee in the flash when `newName` is given. */
      const expectEditSaved = async (
        attendeeId: number,
        edit: Parameters<typeof submitAttendeeEdit>[1],
        newName?: string,
      ): Promise<void> => {
        const response = await submitAttendeeEdit(attendeeId, edit);
        expect(response.status).toBe(302);
        if (newName === undefined) return;
        await expectFlashRedirect(
          `/admin/attendees/${attendeeId}/edit?form=attendee-form#attendee-form`,
          `Updated ${newName}`,
        )(response);
      };

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

      // Every rejected name re-renders the same form (200) with the error
      // inline, so the cases differ only in the name sent and in whether the
      // caller's return_url must come back.
      const rejectedNames: {
        name: string;
        edit: Parameters<typeof submitAttendeeEdit>[1];
        expected: string[];
      }[] = [
        {
          edit: { name: "" },
          expected: ["Name is required"],
          name: "rejects empty name",
        },
        {
          edit: { name: "", returnUrl: "/admin/calendar#attendees" },
          expected: ["Name is required", "/admin/calendar#attendees"],
          name: "preserves return_url on edit validation error",
        },
        {
          edit: { name: "   " },
          expected: ["Name is required"],
          name: "rejects whitespace-only name",
        },
      ];

      for (const { edit, expected, name } of rejectedNames) {
        test(name, async () => {
          const { attendee } = await setupListingAndAttendee();
          const response = await submitAttendeeEdit(attendee.id, edit);
          // Validation failure re-renders the form (200) with the error inline.
          await expectHtmlResponse(response, 200, ...expected);
        });
      }

      test("updates attendee with new data", async () => {
        const { attendee } = await setupListingAndAttendee();
        await expectEditSaved(
          attendee.id,
          {
            address: "456 Oak Ave",
            email: "jane@example.com",
            name: "Jane Doe",
            phone: "555-9999",
            specialInstructions: "Wheelchair access",
          },
          "Jane Doe",
        );

        // Verify the edit form shows the updated data
        const editResponse = await adminGet(
          `/admin/attendees/${attendee.id}/edit`,
        );
        expect(editResponse.status).toBe(200);
        const html = await editResponse.text();
        expectIncludesAll(html, [
          "Jane Doe",
          "jane@example.com",
          "555-9999",
          "456 Oak Ave",
          "Wheelchair access",
        ]);
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
        await expectEditSaved(
          attendee.id,
          { email: "jane@example.com", name: "Jane Smith" },
          "Jane Smith",
        );
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

        const { getAttendeeRaw } = await import("#db/attendees/queries.ts");
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
        const { attendee } = await bookIntoNewListing(
          { email: "john@example.com", name: "John Doe", quantity: 1 },
          { active: true, name: "Listing 1" },
        );
        await createTestListing({
          active: true,
          maxAttendees: 100,
          name: "Listing 2",
        });

        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, "Listing 1", "Listing 2");
      });

      test("shows edit form with empty email field", async () => {
        const { attendee } = await bookIntoNewListing({
          email: "",
          name: "John Doe",
          quantity: 1,
        });

        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, 'type="email"', 'name="email"');
      });

      test("shows inactive listing in registrations table", async () => {
        const { attendee, listing } = await bookIntoNewListing(
          { email: "john@example.com", name: "John Doe", quantity: 1 },
          { name: "Inactive Listing" },
        );

        // Manually set listing to inactive after creating attendee
        const { getDb } = await import("#db/client.ts");
        await getDb().execute(
          sql`UPDATE listings SET active = 0 WHERE id = ${listing.id}`,
        );

        // Listing still shows in registrations table even when inactive
        await expectEditPageRegistrations(attendee.id, "Inactive Listing");
      });

      // Both saves write contact data the form accepts, so each row holds the
      // booking it starts from and the edit it submits; the full row also names
      // the attendee the save flash reports.
      const acceptedEdits: {
        name: string;
        booking: BookAttendeeOpts;
        edit: Parameters<typeof submitAttendeeEdit>[1];
        newName?: string;
      }[] = [
        {
          booking: { email: "john@example.com", name: "John Doe", quantity: 1 },
          edit: { email: "", name: "John Doe" },
          name: "updates attendee with empty email",
        },
        {
          booking: {
            address: "123 Main St",
            email: "john@example.com",
            name: "John Doe",
            phone: "555-1234",
            quantity: 1,
            special_instructions: "VIP",
          },
          edit: {
            address: "456 Oak Ave",
            email: "jane@example.com",
            name: "Jane Smith",
            phone: "555-9999",
            specialInstructions: "Special access needed",
          },
          name: "updates attendee with all non-empty fields",
          newName: "Jane Smith",
        },
      ];

      for (const { booking, edit, name, newName } of acceptedEdits) {
        test(name, async () => {
          const { attendee } = await bookIntoNewListing(booking);
          await expectEditSaved(attendee.id, edit, newName);
        });
      }

      test("shows quantity field on edit form", async () => {
        const { attendee } = await setupListingAndAttendee({
          listing: { maxAttendees: 100, maxQuantity: 5 },
        });
        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, 'name="qty_');
      });

      test("firstAttendee throws on a failed booking result, surfacing the reason", () => {
        expect(() =>
          firstAttendee({ reason: "capacity_exceeded", success: false }),
        ).toThrow("Failed to create attendee: capacity_exceeded");
      });
    });
  },
);
