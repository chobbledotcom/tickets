// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postHeldPayment } from "#test-utils/ledger.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminAttendeeAction,
  adminFormPost,
  adminGet,
  adminListingPage,
  setupListingAndLogin,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

// jscpd:ignore-end
import { setupListingAndAttendee, stageMidPaymentAttendee } from "./helpers.ts";

/** A listing plus "John Doe" attendee, with the thank-you URL set — the
 *  shared setup for the delete GET/POST/DELETE auth and 404 tests. */
const setupDeleteListingAndAttendee = (): ReturnType<
  typeof setupListingAndAttendee
> =>
  setupListingAndAttendee({
    listing: {
      maxAttendees: 100,
      thankYouUrl: "https://example.com",
    },
  });

describeWithEnv("server (admin attendees) > delete", { db: true }, () => {
  const deleteAction = adminAttendeeAction("delete");

  describe("GET /admin/listing/:listingId/attendee/:attendeeId/delete", () => {
    testRequiresAuth("/admin/attendees/1/delete", {
      setup: async () => {
        await setupDeleteListingAndAttendee();
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/attendees/1/delete");
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await adminGet("/admin/attendees/999/delete");
      expect(response.status).toBe(404);
    });

    test("returns 404 for an orphan attendee with no home listing", async () => {
      // The attendee-scoped action loads the attendee's home listing; an
      // attendee whose bookings are all gone has none, so the page 404s.
      const { attendee } = await setupListingAndAttendee({
        listing: {
          maxAttendees: 100,
          name: "Listing 1",
          thankYouUrl: "https://example.com",
        },
      });
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute(
        "DELETE FROM listing_attendees WHERE attendee_id = ?",
        [attendee.id],
      );

      const response = await adminGet(`/admin/attendees/${attendee.id}/delete`);
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const { response } = await adminListingPage(
        (ctx) => `/admin/attendees/${ctx.attendee.id}/delete`,
      )();
      await expectHtmlResponse(
        response,
        200,
        "Delete Attendee",
        "John Doe",
        "type their name",
        'checked name="release_bookings" type="checkbox" value="1"',
        "Release their bookings into the pool",
      );
    });

    test("includes return_url as hidden field when provided", async () => {
      const { response } = await adminListingPage(
        (ctx) =>
          `/admin/attendees/${ctx.attendee.id}/delete?return_url=${encodeURIComponent(
            "/admin/calendar#attendees",
          )}`,
      )();
      await expectHtmlResponse(
        response,
        200,
        'name="return_url"',
        "/admin/calendar#attendees",
      );
    });
  });

  describe("POST /admin/listing/:listingId/attendee/:attendeeId/delete", () => {
    testRequiresAuth("/admin/attendees/1/delete", {
      body: {
        confirm_identifier: "John Doe",
      },
      method: "POST",
      setup: async () => {
        await setupDeleteListingAndAttendee();
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/attendees/1/delete", {
        confirm_identifier: "John Doe",
      });
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/attendees/999/delete", {
        confirm_identifier: "John Doe",
      });
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await deleteAction({
        confirm_identifier: "John Doe",
        csrf_token: "invalid-token",
      })();
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const { response } = await deleteAction({
        confirm_identifier: "Wrong Name",
      })();
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });

    test("preserves return_url on mismatched attendee name", async () => {
      const { response } = await deleteAction({
        confirm_identifier: "Wrong Name",
        return_url: "/admin/calendar#attendees",
      })();
      expect(response.status).toBe(302);
      expectFlash(
        response,
        "Attendee name does not match. Please type the exact attendee name to confirm deletion.",
        false,
      );
      // The bounce-back confirm page must keep the caller's return_url so a
      // corrected retry still lands where the operator came from.
      const location = response.headers.get("location") ?? "";
      expect(location).toContain(
        `return_url=${encodeURIComponent("/admin/calendar#attendees")}`,
      );
    });

    test("deletes attendee with matching name (case insensitive)", async () => {
      const { response, listing, attendee } = await deleteAction({
        confirm_identifier: "john doe",
        release_bookings: "1",
      })();
      await expectFlashRedirect(
        "/admin/attendees",
        "Attendee deleted",
      )(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
      expect(await getListingWithCount(listing.id)).toMatchObject({
        attendee_count: 0,
      });
    });

    test("deletes attendee with whitespace-trimmed name", async () => {
      const { response } = await deleteAction({
        confirm_identifier: "  John Doe  ",
      })();
      await expectFlashRedirect(
        "/admin/attendees",
        "Attendee deleted",
      )(response);
    });

    test("refuses to delete a mid-payment staged attendee", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      // A staged quantity-0 attendee whose payment can still land and claim its
      // exact rows: confirming by name gets past the confirmation step, but the
      // pending guard blocks the delete until the checkout finishes or expires.
      const stage = await stageMidPaymentAttendee(
        listing,
        "cs_attendee_delete_guard",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${stage.attendeeId}/delete`,
        { confirm_identifier: "Buyer" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("mid-payment"), false);
      // The staged rows survive the refused delete.
      const { getAttendeeRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      expect(await getAttendeeRaw(stage.attendeeId)).not.toBeNull();
    });

    test("refuses to delete a record holding unreturned conflict cash", async () => {
      const { listing } = await setupListingAndLogin({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Held Buyer",
        "held-delete@example.com",
      );
      // A stage_active conflict resolves its stage but leaves a held provider
      // payment (no sale) the operator must still refund; deleting would orphan
      // that ledger cash. Confirming by name gets past the confirmation step.
      await postHeldPayment({
        amount: 1000,
        attendeeId: attendee.id,
        listingId: listing.id,
      });

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/delete`,
        { confirm_identifier: "Held Buyer" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("not refunded"), false);
      // The record survives so the operator can still refund the held cash.
      const { getAttendeeRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      expect(await getAttendeeRaw(attendee.id)).not.toBeNull();
    });

    test("can delete attendee without releasing bookings", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Keep Pool",
        "keep-pool@example.com",
        "pay_keep_pool",
        1200,
        3,
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/delete`,
        { confirm_identifier: "Keep Pool" },
      );

      await expectFlashRedirect(
        "/admin/attendees",
        "Attendee deleted",
      )(response);
      const updated = await getListingWithCount(listing.id);
      expect(updated).toMatchObject({
        attendee_count: 3,
        income: 1200,
        tickets_count: 1,
      });
    });
  });

  describe("DELETE /admin/listing/:listingId/attendee/:attendeeId/delete", () => {
    test("deletes attendee with DELETE method", async () => {
      const { attendee } = await setupDeleteListingAndAttendee();

      const formBody = new URLSearchParams({
        confirm_identifier: "John Doe",
        csrf_token: await testCsrfToken(),
      }).toString();

      const response = await handleRequest(
        new Request(`http://localhost/admin/attendees/${attendee.id}/delete`, {
          body: formBody,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: await testCookie(),
            host: "localhost",
          },
          method: "DELETE",
        }),
      );
      await expectFlashRedirect(
        "/admin/attendees",
        "Attendee deleted",
      )(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const deletedAttendee = await getAttendeeRaw(1);
      expect(deletedAttendee).toBeNull();
    });
  });

  describe("POST /admin/listing/:listingId/attendee/:attendeeId/delete (confirm_identifier edge case)", () => {
    test("handles missing confirm_identifier field (falls back to empty string)", async () => {
      // Submit without confirm_identifier field at all
      const { response } = await deleteAction({})();
      // Empty string won't match "John Doe", so it redirects with error
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });
  });

  describe("routes/admin/attendees.ts (parseAttendeeIds)", () => {
    test("returns 404 for non-existent attendee on delete page", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Att Del 404",
      });

      const response = await handleRequest(
        new Request(
          `http://localhost/admin/listing/${listing.id}/attendee/99999/delete`,
          {
            headers: {
              cookie,
              host: "localhost",
            },
          },
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("routes/admin/attendees.ts (parseAttendeeIds)", () => {
    test("exercises parseAttendeeIds via POST route with valid params", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Parse Ids Test",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Test User",
        "test@example.com",
      );

      // POST route exercises attendeeDeleteHandler which calls parseAttendeeIds.
      // The custom handler requires confirm_identifier to match the attendee name.
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}/delete`,
          { confirm_identifier: "Test User", csrf_token: csrfToken },
          cookie,
        ),
      );
      // Should redirect after successful delete
      expect(response.status).toBe(302);
    });
  });
});
