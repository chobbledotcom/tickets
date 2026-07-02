import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { attendeesApi } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import {
  answersTable,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { paymentsApi } from "#shared/payments.ts";
import {
  adminAttendeeAction,
  adminFormPost,
  adminGet,
  adminListingPage,
  assertAdminHtml,
  awaitTestRequest,
  bookAttendee,
  buildAttendeeEditForm,
  createPaidAttendeeWithoutLedger,
  createPaidTestAttendee,
  createTestAttendee,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  extractInputValue,
  FLASH_TEST_ID,
  flashCookieHeader,
  followRedirectWithFlash,
  getAttendeesRaw,
  mockFormRequest,
  mockProviderType,
  rawListingRange,
  setupAdminTest,
  setupListingAndLogin,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

describeWithEnv("server (admin attendees)", { db: true }, () => {
  const deleteAction = adminAttendeeAction("delete");
  const checkinAction = adminAttendeeAction("checkin");

  describe("GET /admin/listing/:listingId/attendee/:attendeeId/delete", () => {
    testRequiresAuth("/admin/listing/1/attendee/1/delete", {
      setup: async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
        await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/attendee/1/delete");
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await adminGet("/admin/listing/1/attendee/999/delete");
      expect(response.status).toBe(404);
    });

    test("returns 404 when attendee belongs to different listing", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 100,
        name: "Listing 1",
        thankYouUrl: "https://example.com",
      });
      const listing2 = await createTestListing({
        maxAttendees: 100,
        name: "Listing 2",
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing2.id,
        listing2.slug,
        "John Doe",
        "john@example.com",
      );

      // Try to delete attendee from listing 2 via listing 1 URL
      const response = await adminGet(
        `/admin/listing/${listing1.id}/attendee/${attendee.id}/delete`,
      );
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const { response } = await adminListingPage(
        (ctx) =>
          `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/delete`,
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
          `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/delete?return_url=${encodeURIComponent(
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
    testRequiresAuth("/admin/listing/1/attendee/1/delete", {
      body: {
        confirm_identifier: "John Doe",
      },
      method: "POST",
      setup: async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
        await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/999/attendee/1/delete",
        { confirm_identifier: "John Doe" },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost(
        "/admin/listing/1/attendee/999/delete",
        { confirm_identifier: "John Doe" },
      );
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
      expectFlash(response, expect.stringContaining("does not match"), false);
    });

    test("deletes attendee with matching name (case insensitive)", async () => {
      const { response, listing, attendee } = await deleteAction({
        confirm_identifier: "john doe",
        release_bookings: "1",
      })();
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Attendee deleted",
      )(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
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
        "/admin/listing/1",
        "Attendee deleted",
      )(response);
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
        `/admin/listing/${listing.id}/attendee/${attendee.id}/delete`,
        { confirm_identifier: "Keep Pool" },
      );

      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
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
      const listing = await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );

      const formBody = new URLSearchParams({
        confirm_identifier: "John Doe",
        csrf_token: await testCsrfToken(),
      }).toString();

      const response = await handleRequest(
        new Request(
          `http://localhost/admin/listing/${listing.id}/attendee/${attendee.id}/delete`,
          {
            body: formBody,
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: await testCookie(),
              host: "localhost",
            },
            method: "DELETE",
          },
        ),
      );
      await expectFlashRedirect(
        "/admin/listing/1",
        "Attendee deleted",
      )(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
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
          `/admin/listing/${listing.id}/attendee/${attendee.id}/delete`,
          { confirm_identifier: "Test User", csrf_token: csrfToken },
          cookie,
        ),
      );
      // Should redirect after successful delete
      expect(response.status).toBe(302);
    });
  });

  describe("POST /admin/listing/:listingId/attendee/:attendeeId/delete-incomplete", () => {
    testRequiresAuth("/admin/listing/1/attendee/1/delete-incomplete", {
      body: {},
      method: "POST",
      setup: async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 1000,
        });
        await createPaidTestAttendee(
          listing.id,
          "John Doe",
          "john@example.com",
          "",
          1000,
        );
      },
    });

    test("deletes incomplete attendee without name confirmation", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Jane Stuck",
        "jane@example.com",
        "",
        1000,
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Incomplete registration removed",
      )(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
    });

    test("refuses to delete complete attendee via delete-incomplete", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "John Paid",
        "john@example.com",
        "pi_test_123",
        1000,
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        undefined,
        false,
      )(response);

      // Verify attendee was NOT deleted (still exists)
      const rows = await getAttendeesRaw(listing.id);
      expect(rows.length).toBe(1);
    });

    test("refuses to delete admin-added attendee on paid listing via delete-incomplete", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      // Admin-added attendee: no payment_id and price_paid=0
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Admin Added",
        "admin@example.com",
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        undefined,
        false,
      )(response);

      // Verify attendee was NOT deleted
      const rows = await getAttendeesRaw(listing.id);
      expect(rows.length).toBe(1);
    });

    test("deletes incomplete attendee on free can_pay_more listing", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        canPayMore: true,
        maxAttendees: 100,
        unitPrice: 0,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "Jane Stuck",
        "jane@example.com",
        "",
        500,
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Incomplete registration removed",
      )(response);

      const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
    });

    test("returns 404 for non-existent attendee", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 100,
        unitPrice: 1000,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/999/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/listing/:listingId/attendee/:attendeeId/checkin", () => {
    testRequiresAuth("/admin/listing/1/attendee/1/checkin", {
      body: {},
      method: "POST",
      setup: async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
        await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await checkinAction({
        csrf_token: "invalid-token",
      })();
      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost(
        "/admin/listing/1/attendee/999/checkin",
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/999/attendee/1/checkin",
      );
      expect(response.status).toBe(404);
    });

    test("checks in an attendee and redirects with message", async () => {
      const { response, listing } = await checkinAction({})();
      expectRedirect(
        response,
        `/admin/listing/${listing.id}`,
        "checkin_status=in",
        "checkin_name=John",
        "#message",
      );
    });

    test("redirects to filtered page when return_filter is set", async () => {
      const { response, listing } = await checkinAction({
        return_filter: "in",
      })();
      expectRedirect(
        response,
        `/admin/listing/${listing.id}/in?`,
        "checkin_status=in",
      );
    });

    test("redirects to out filtered page when return_filter is out", async () => {
      // Check in first, then check out with return_filter=out
      const { listing, attendee, cookie, csrfToken } = await checkinAction(
        {},
      )();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken, return_filter: "out" },
          cookie,
        ),
      );
      expectRedirect(
        response,
        `/admin/listing/${listing.id}/out?`,
        "checkin_status=out",
      );
    });

    test("redirects to unfiltered page when return_filter is all", async () => {
      const { response, listing } = await checkinAction({
        return_filter: "all",
      })();
      const location = expectRedirect(
        response,
        `/admin/listing/${listing.id}?`,
      );
      expect(location).not.toContain("/in?");
      expect(location).not.toContain("/out?");
    });

    test("redirects to return_url when provided", async () => {
      const { response } = await checkinAction({
        return_url: "/admin/calendar?date=2026-03-15#attendees",
      })();
      expectRedirect(
        response,
        "/admin/calendar",
        "date=2026-03-15",
        "#attendees",
      );
      expectFlash(response, expect.stringContaining("Checked"));
    });

    test("checks out an already checked-in attendee", async () => {
      // First check in via the curried helper
      const { listing, attendee, cookie, csrfToken } = await checkinAction(
        {},
      )();

      // Then check out
      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expectRedirect(response, "checkin_status=out");
    });

    test("listing page shows Check in button for unchecked attendee", async () => {
      const { response } = await adminListingPage(
        (ctx) => `/admin/listing/${ctx.listing.id}`,
      )();
      await expectHtmlResponse(response, 200, "Check in", "/checkin");
    });

    test("listing page shows check-in success message when query params present", async () => {
      const { response } = await adminListingPage(
        (ctx) =>
          `/admin/listing/${ctx.listing.id}?checkin_name=John%20Doe&checkin_status=in`,
      )();
      await expectHtmlResponse(
        response,
        200,
        "Checked John Doe in",
        "checkin-message-in",
      );
    });

    test("listing page shows check-out message in red", async () => {
      const { response } = await adminListingPage(
        (ctx) =>
          `/admin/listing/${ctx.listing.id}?checkin_name=John%20Doe&checkin_status=out`,
      )();
      await expectHtmlResponse(
        response,
        200,
        "Checked John Doe out",
        "checkin-message-out",
      );
    });

    test("listing page ignores invalid checkin_status param", async () => {
      const { response } = await adminListingPage(
        (ctx) =>
          `/admin/listing/${ctx.listing.id}?checkin_name=John%20Doe&checkin_status=invalid`,
      )();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Checked John Doe");
    });

    test("listing page shows Check out button for checked-in attendee", async () => {
      // Check in first, then view the listing page
      const { listing } = await checkinAction({})();

      await assertAdminHtml(`/admin/listing/${listing.id}`, "Check out");
    });
  });

  describe("no-quantity row action guards", () => {
    /** Set up an admin session + attendee whose single line is a quantity-0
     * sentinel, then POST one of its listing-scoped actions. */
    const ghostRowAction = async (
      action: string,
    ): Promise<{ response: Response; listingId: number }> => {
      const ctx = await setupAdminTest();
      await getDb().execute({
        args: [ctx.attendee.id, ctx.listing.id],
        sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ? AND listing_id = ?",
      });
      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/${action}`,
          // setupAdminTest creates the attendee as "John Doe"; verified actions
          // (resend/refund) require the exact name in confirm_identifier.
          { confirm_identifier: "John Doe", csrf_token: ctx.csrfToken },
          ctx.cookie,
        ),
      );
      return { listingId: ctx.listing.id, response };
    };

    test("check-in refuses a no-quantity row and leaves it unchecked", async () => {
      const { response, listingId } = await ghostRowAction("checkin");
      expectFlash(response, "Cannot check in a no-quantity line", false);
      const row = await getDb().execute({
        args: [listingId],
        sql: "SELECT checked_in FROM listing_attendees WHERE listing_id = ?",
      });
      expect(Number(row.rows[0]!.checked_in)).toBe(0);
    });

    test("re-send notification refuses a no-quantity row", async () => {
      const { response } = await ghostRowAction("resend-notification");
      expectFlash(
        response,
        "Cannot re-send a notification for a no-quantity line",
        false,
      );
    });

    test("refund refuses a no-quantity row (no payment to refund)", async () => {
      const { response } = await ghostRowAction("refund");
      // The listing-scoped refund hides on a ghost row rather than refunding a
      // charge from a listing it doesn't belong to.
      expectRedirect(response, "/refund");
      expectFlash(response, expect.stringContaining("no payment"), false);
    });
  });

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

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee`,
          {
            csrf_token: "invalid-token",
            email: "jane@example.com",
            name: "Jane Doe",
            quantity: "1",
          },
          cookie,
        ),
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

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee`,
          {
            csrf_token: csrfToken,
            email: "jane@example.com",
            name: "Jane Doe",
            quantity: "1",
          },
          cookie,
        ),
      );
      expectRedirect(response, `/admin/listing/${listing.id}`);
      expectFlash(response, expect.stringContaining("Added"));

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
    });

    test("adds a customisable daily attendee spanning the chosen day count", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        customisableDays: true,
        dayPrices: { 1: 0, 2: 0, 3: 0 },
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 100,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee`,
          {
            csrf_token: csrfToken,
            date: "2026-09-10",
            day_count: "2",
            email: "jane@example.com",
            name: "Jane Doe",
            quantity: "1",
          },
          cookie,
        ),
      );
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

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee`,
          {
            csrf_token: csrfToken,
            name: "Phone User",
            phone: "+1234567890",
            quantity: "1",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Added"));

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
    });

    test("adds attendee to both listing", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        fields: "email,phone",
        maxAttendees: 100,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee`,
          {
            csrf_token: csrfToken,
            email: "both@example.com",
            name: "Both User",
            phone: "+1234567890",
            quantity: "2",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Added"));

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.quantity).toBe(2);
    });

    test("redirects with error on validation failure", async () => {
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 100,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee`,
          {
            csrf_token: csrfToken,
            email: "",
            name: "",
            quantity: "1",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining(""), false);
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
          const response = await handleRequest(
            mockFormRequest(
              `/admin/listing/${listing.id}/attendee`,
              {
                csrf_token: csrfToken,
                email: "enc@example.com",
                name: "Enc Fail",
                quantity: "1",
              },
              cookie,
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(response, expect.stringContaining("Encryption"), false);
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

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee`,
          {
            csrf_token: csrfToken,
            date: futureDate,
            email: "daily@example.com",
            name: "Daily User",
            quantity: "1",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Added"));

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.date).toBe(futureDate);
    });

    test("listing page shows add attendee form", async () => {
      const { listing } = await setupListingAndLogin({ maxAttendees: 100 });

      await assertAdminHtml(
        `/admin/listing/${listing.id}`,
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

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Added Jane Doe")}`,
        },
      );
      await expectHtmlResponse(response, 200, "Added Jane Doe");
    });

    test("listing page shows error message when flash cookie present", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
      });

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Not enough spots", false)}`,
        },
      );
      await expectHtmlResponse(response, 200, "Not enough spots");
    });
  });

  describe("GET /admin/attendees/:attendeeId", () => {
    testRequiresAuth("/admin/attendees/1", {
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
      const response = await adminGet("/admin/attendees/999");
      expect(response.status).toBe(404);
    });

    test("shows edit form with prefilled attendee data", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const result = await bookAttendee(listing, {
        address: "123 Main St",
        email: "john@example.com",
        name: "John Doe",
        phone: "555-1234",
        quantity: 1,
        special_instructions: "VIP guest",
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendees[0]!;

      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Edit Attendee",
        "John Doe",
        "john@example.com",
        "555-1234",
        "123 Main St",
        "VIP guest",
      );
    });

    test("includes return_url as hidden field when provided", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${attendee.id}?return_url=${encodeURIComponent(
          "/admin/calendar#attendees",
        )}`,
      );
      await expectHtmlResponse(
        response,
        200,
        'name="return_url"',
        "/admin/calendar#attendees",
      );
    });

    test("shows current listing in registrations table", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Current Listing",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Current Listing",
        "Listing Registrations",
      );
    });

    test("edit page shows listing registrations and add-to-listing sections", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Edit Page Listing",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Edit User",
        "edit@example.com",
      );
      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      const html = await expectHtmlResponse(
        response,
        200,
        "Listing Registrations",
        "Save Attendee",
      );
      // Listing link table shows the listing
      expect(html).toContain("Edit Page Listing");
      // The editor renders a quantity box per listing
      expect(html).toContain("qty_");
    });

    test("edit page shows checked-in badge for checked-in attendee", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Checkin Badge Listing",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Badge User",
        "badge@example.com",
      );
      const { updateCheckedIn } = await import("#shared/db/attendees.ts");
      await updateCheckedIn(attendee.id, listing.id, true);
      const { invalidateListingsCache } = await import(
        "#shared/db/listings.ts"
      );
      invalidateListingsCache();
      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      await expectHtmlResponse(response, 200, "Checked in");
    });

    test("edit page seeds the shared start date from a daily booking", async () => {
      const listing = await createTestListing({
        listingType: "daily",
        maxAttendees: 100,
        name: "Daily Dates Listing",
      });
      const result = await bookAttendee(listing, {
        date: "2026-04-07",
        email: "daily@example.com",
        name: "Daily User",
      });
      if (!result.success) throw new Error("Failed");
      const attendeeId = result.attendees[0]!.id;
      const response = await adminGet(`/admin/attendees/${attendeeId}`);
      const html = await expectHtmlResponse(
        response,
        200,
        "Daily Dates Listing",
      );
      // The shared start date is seeded from the daily booking.
      expect(html).toContain('value="2026-04-07"');
    });

    test("includes active listings in add-to-listing selector", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 100,
        name: "Listing 1",
      });
      await createTestListing({
        active: true,
        maxAttendees: 100,
        name: "Listing 2",
      });
      const attendee = await createTestAttendee(
        listing1.id,
        listing1.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      await expectHtmlResponse(response, 200, "Listing 1", "Listing 2");
    });
  });

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
        `/admin/attendees/${attendee.id}#attendee-form`,
        "Updated Jane Doe",
      )(response);

      // Verify the edit form shows the updated data
      const editResponse = await adminGet(`/admin/attendees/${attendee.id}`);
      expect(editResponse.status).toBe(200);
      const html = await editResponse.text();
      expect(html).toContain("Jane Doe");
      expect(html).toContain("jane@example.com");
      expect(html).toContain("555-9999");
      expect(html).toContain("456 Oak Ave");
      expect(html).toContain("Wheelchair access");
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
        `/admin/attendees/${attendee.id}#attendee-form`,
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
      const response = await adminGet(`/admin/listing/${listing.id}`);
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

      const response = await adminGet(`/admin/attendees/${attendee.id}`);
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

      const response = await adminGet(`/admin/attendees/${attendee.id}`);
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

      const response = await adminGet(`/admin/attendees/${attendee.id}`);
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
        `/admin/attendees/${attendee.id}#attendee-form`,
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
      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      await expectHtmlResponse(response, 200, 'name="qty_');
    });
  });

  describe("GET /admin/listing/:listingId/attendee/:attendeeId/resend-notification", () => {
    testRequiresAuth("/admin/listing/1/attendee/1/resend-notification", {
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

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet(
        "/admin/listing/999/attendee/1/resend-notification",
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestListing({ maxAttendees: 100 });

      const response = await adminGet(
        "/admin/listing/1/attendee/999/resend-notification",
      );
      expect(response.status).toBe(404);
    });

    test("shows resend notification confirmation page when authenticated", async () => {
      const { response } = await adminListingPage(
        (ctx) =>
          `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/resend-notification`,
      )();
      await expectHtmlResponse(
        response,
        200,
        "Re-send Notification",
        "John Doe",
        "type their name",
      );
    });

    test("includes return_url as hidden field when provided", async () => {
      const { response } = await adminListingPage(
        (ctx) =>
          `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/resend-notification?return_url=${encodeURIComponent(
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

    test("shows error message when attendee name does not match", async () => {
      const { listing, attendee, cookie, csrfToken } = await setupAdminTest();
      const postResponse = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${attendee.id}/resend-notification`,
          { confirm_identifier: "Wrong Name", csrf_token: csrfToken },
          cookie,
        ),
      );
      const page = await followRedirectWithFlash(
        postResponse,
        handleRequest,
        cookie,
      );
      const html = await page.text();
      expect(html).toContain("does not match");
    });

    test("shows amount paid on resend notification page for paid attendee", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        unitPrice: 1000,
      });

      const result = await bookAttendee(listing, {
        email: "jane@example.com",
        name: "Jane Paid",
        paymentId: "pi_test",
        pricePaid: 1000,
        quantity: 1,
      });

      if (!result.success) {
        throw new Error("Failed to create attendee");
      }

      const response = await adminGet(
        `/admin/listing/${listing.id}/attendee/${
          result.attendees[0]!.id
        }/resend-notification`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Re-send Notification",
        "Jane Paid",
        "Amount Paid",
      );
    });
  });

  describe("POST /admin/listing/:listingId/attendee/:attendeeId/resend-notification", () => {
    const resendNotificationAction = adminAttendeeAction("resend-notification");

    testRequiresAuth("/admin/listing/1/attendee/1/resend-notification", {
      body: {
        confirm_identifier: "John Doe",
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

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/999/attendee/1/resend-notification",
        { confirm_identifier: "John Doe" },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestListing({ maxAttendees: 100 });

      const { response } = await adminFormPost(
        "/admin/listing/1/attendee/999/resend-notification",
        { confirm_identifier: "John Doe" },
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await resendNotificationAction({
        confirm_identifier: "John Doe",
        csrf_token: "invalid-token",
      })();
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const { response } = await resendNotificationAction({
        confirm_identifier: "Wrong Name",
      })();
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });

    test("re-sends notification with matching name", async () => {
      const webhookFetch = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response(null, { status: 200 })),
      );

      try {
        const { response, listing } = await resendNotificationAction({
          confirm_identifier: "John Doe",
        })({
          webhookUrl: "https://example.com/webhook",
        });
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}`,
          "Notification re-sent",
        )(response);

        // Verify webhook was sent
        expect(webhookFetch.calls.length).toBeGreaterThan(0);
      } finally {
        webhookFetch.restore();
      }
    });

    test("logs activity when notification is re-sent", async () => {
      const webhookFetch = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response(null, { status: 200 })),
      );

      try {
        const { response, listing } = await resendNotificationAction({
          confirm_identifier: "John Doe",
        })({
          webhookUrl: "https://example.com/webhook",
        });
        expect(response.status).toBe(302);

        // Verify activity was logged
        const { getListingActivityLog } = await import("#test-utils");
        const logs = await getListingActivityLog(listing.id);
        const resendLog = logs.find((l: { message: string }) =>
          l.message.includes("Notification re-sent"),
        );
        expect(resendLog).toBeDefined();
        expect(resendLog?.message).toContain("John Doe");
      } finally {
        webhookFetch.restore();
      }
    });

    test("a package member's resend rehydrates every line of the package", async () => {
      // The listing-scoped resend selects ONE member row, but the notification
      // must carry the attendee's whole package — otherwise a hidden package's
      // confirmation collapses to that single row's quantity/price.
      const { createTestGroup } = await import("#test-utils");
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const group = await createTestGroup({ isPackage: true, name: "Duo Kit" });
      const memberA = await createTestListing({
        groupId: group.id,
        name: "Duo A",
        webhookUrl: "https://example.com/webhook",
      });
      const memberB = await createTestListing({
        groupId: group.id,
        name: "Duo B",
      });
      const result = await createAttendeeAtomic({
        bookings: [
          { listingId: memberA.id, quantity: 1 },
          { listingId: memberB.id, quantity: 2 },
        ],
        email: "duo@example.com",
        name: "Duo Buyer",
        packageGroupId: group.id,
      });
      if (!result.success) throw new Error("package booking failed");

      const webhookFetch = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response(null, { status: 200 })),
      );
      try {
        const { response } = await adminFormPost(
          `/admin/listing/${memberA.id}/attendee/${
            result.attendees[0]!.id
          }/resend-notification`,
          { confirm_identifier: "Duo Buyer" },
        );
        expect(response.status).toBe(302);
        // Allow the fire-and-forget webhook to dispatch.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(webhookFetch.calls.length).toBe(1);
        const [, options] = webhookFetch.calls[0]!.args as [
          string,
          RequestInit,
        ];
        const body = JSON.parse(options.body as string) as {
          tickets: { listing_name: string; quantity: number }[];
        };
        // BOTH package lines ride the resend, with their own quantities.
        expect(body.tickets).toHaveLength(2);
        const byName = new Map(
          body.tickets.map((t) => [t.listing_name, t.quantity]),
        );
        expect(byName.get("Duo A")).toBe(1);
        expect(byName.get("Duo B")).toBe(2);
      } finally {
        webhookFetch.restore();
      }
    });
  });

  describe("payment details on edit page", () => {
    test("shows payment details for paid attendee", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      const result = await bookAttendee(listing, {
        email: "paid@example.com",
        name: "Paid User",
        paymentId: "pi_test_123",
        pricePaid: 1000,
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const response = await adminGet(
        `/admin/attendees/${result.attendees[0]!.id}`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Payment Details",
        "pi_test_123",
        "Not refunded",
        "Refresh payment status",
      );
    });

    test("links the payment id to the configured provider dashboard", async () => {
      settings.setForTest({
        payment_provider: "stripe",
        stripe_secret_key: "sk_live_abc",
      });
      try {
        const listing = await createTestListing({
          maxAttendees: 100,
          unitPrice: 1000,
        });
        const result = await bookAttendee(listing, {
          email: "linked@example.com",
          name: "Linked User",
          paymentId: "pi_linked_123",
          pricePaid: 1000,
          quantity: 1,
        });
        if (!result.success) throw new Error("Failed to create attendee");
        const response = await adminGet(
          `/admin/attendees/${result.attendees[0]!.id}`,
        );
        await expectHtmlResponse(
          response,
          200,
          'href="https://dashboard.stripe.com/payments/pi_linked_123"',
          'target="_blank"',
        );
      } finally {
        settings.clearTestOverrides();
      }
    });

    test("shows refunded status for refunded attendee", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
      const result = await bookAttendee(listing, {
        email: "refunded@example.com",
        name: "Refunded User",
        paymentId: "pi_refunded_123",
        pricePaid: 1000,
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      await postAttendeeRefund({
        attendeeId: result.attendees[0]!.id,
        listingId: listing.id,
      });
      const response = await adminGet(
        `/admin/attendees/${result.attendees[0]!.id}`,
      );
      await expectHtmlResponse(response, 200, "Refunded");
    });

    test("shows both badges for a checked-in and refunded booking", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      const { updateCheckedIn } = await import("#shared/db/attendees.ts");
      const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
      const result = await bookAttendee(listing, {
        email: "both@example.com",
        name: "Both Badges",
        paymentId: "pi_both_123",
        pricePaid: 1000,
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      await updateCheckedIn(result.attendees[0]!.id, listing.id, true);
      await postAttendeeRefund({
        attendeeId: result.attendees[0]!.id,
        listingId: listing.id,
      });
      const response = await adminGet(
        `/admin/attendees/${result.attendees[0]!.id}`,
      );
      const html = await response.text();
      expect(response.status).toBe(200);
      // Both badges render, separated by the space between them.
      expect(html).toContain("Checked in");
      expect(html).toContain("Refunded");
    });

    test("shows success message when flash cookie present", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader(
            "Payment status is up to date",
          )}`,
        },
      );
      await expectHtmlResponse(response, 200, "Payment status is up to date");
    });

    test("does not show payment details for free attendee", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Free User",
        "free@example.com",
      );
      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Payment Details");
    });
  });

  describe("POST /admin/attendees/:attendeeId/refresh-payment", () => {
    testRequiresAuth("/admin/attendees/1/refresh-payment", {
      body: {},
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

    test("redirects to edit page when attendee has no payment", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/refresh-payment`,
      );
      expect(response.status).toBe(302);
      await expectFlashRedirect(
        `/admin/attendees/${attendee.id}`,
        "No payment to refresh",
        false,
      )(response);
    });

    test("returns 404 for non-existent attendee", async () => {
      const { response } = await adminFormPost(
        "/admin/attendees/999/refresh-payment",
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 when attendee has no bookings", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      const db = getDbFn();
      await db.execute({
        args: [attendee.id],
        sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/refresh-payment`,
      );
      expect(response.status).toBe(404);
    });

    test("returns error when no payment provider configured", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        unitPrice: 500,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "John Doe",
        "john@example.com",
        "pi_no_provider",
      );
      await withMocks(
        () => stub(paymentsApi, "getConfiguredProvider", () => null),
        async () => {
          const { response } = await adminFormPost(
            `/admin/attendees/${attendee.id}/refresh-payment`,
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("payment provider"),
            false,
          );
        },
      );
    });

    test("marks as refunded when Stripe reports refund", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        unitPrice: 500,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "John Doe",
        "john@example.com",
        "pi_refresh_refund",
      );
      await withMocks(
        () =>
          stub(paymentsApi, "getConfiguredProvider", () =>
            mockProviderType("stripe"),
          ),
        async () => {
          const { stripePaymentProvider } = await import(
            "#shared/stripe-provider.ts"
          );
          const mockRefunded = stub(
            stripePaymentProvider,
            "isPaymentRefunded",
            () => Promise.resolve(true),
          );
          try {
            const { response } = await adminFormPost(
              `/admin/attendees/${attendee.id}/refresh-payment`,
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toContain(
              `/admin/attendees/${attendee.id}`,
            );
            expectFlash(response, expect.stringContaining("refunded"));
            expect(mockRefunded.calls[0]!.args).toEqual(["pi_refresh_refund"]);
          } finally {
            mockRefunded.restore();
          }
        },
      );
    });

    test("surfaces a Stripe refund the ledger could not record", async () => {
      // Stripe reports the payment refunded, but the booking predates the ledger
      // so the reversal finds no clean order to post. Refund status is ledger-only
      // now, so this must surface for a manual adjustment rather than silently
      // succeed and leave the payment looking un-refunded.
      const listing = await createTestListing({
        maxAttendees: 100,
        unitPrice: 500,
      });
      const attendee = await createPaidAttendeeWithoutLedger(
        listing.id,
        "John Doe",
        "john@example.com",
        "pi_refresh_unrecorded",
      );
      await withMocks(
        () =>
          stub(paymentsApi, "getConfiguredProvider", () =>
            mockProviderType("stripe"),
          ),
        async () => {
          const { stripePaymentProvider } = await import(
            "#shared/stripe-provider.ts"
          );
          const mockRefunded = stub(
            stripePaymentProvider,
            "isPaymentRefunded",
            () => Promise.resolve(true),
          );
          try {
            const { response } = await adminFormPost(
              `/admin/attendees/${attendee.id}/refresh-payment`,
            );
            expect(response.status).toBe(302);
            expectFlash(
              response,
              expect.stringContaining("could not be recorded"),
              false,
            );
          } finally {
            mockRefunded.restore();
          }
        },
      );
    });

    test("redirects without marking refunded when payment is not refunded", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        unitPrice: 500,
      });
      const attendee = await createPaidTestAttendee(
        listing.id,
        "John Doe",
        "john@example.com",
        "pi_refresh_ok",
      );
      await withMocks(
        () =>
          stub(paymentsApi, "getConfiguredProvider", () =>
            mockProviderType("stripe"),
          ),
        async () => {
          const { stripePaymentProvider } = await import(
            "#shared/stripe-provider.ts"
          );
          const mockRefunded = stub(
            stripePaymentProvider,
            "isPaymentRefunded",
            () => Promise.resolve(false),
          );
          try {
            const { response } = await adminFormPost(
              `/admin/attendees/${attendee.id}/refresh-payment`,
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toContain(
              `/admin/attendees/${attendee.id}`,
            );
            expectFlash(response, expect.stringContaining("up to date"));
          } finally {
            mockRefunded.restore();
          }
        },
      );
    });
  });

  describe("edit attendee questions", () => {
    const setupQuestionAndAttendee = async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      // Create attendee before assigning questions (public route requires answers)
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "T-shirt size?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });
      await setListingQuestions(listing.id, [q.id]);
      return { a1, a2, attendee, listing, q };
    };

    test("shows questions on edit page", async () => {
      const { attendee } = await setupQuestionAndAttendee();
      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      await expectHtmlResponse(
        response,
        200,
        "T-shirt size?",
        "Small",
        "Large",
      );
    });

    test("pre-selects existing answer on edit page", async () => {
      const { attendee, a1, q } = await setupQuestionAndAttendee();
      const { saveAttendeeAnswers } = await import("#shared/db/questions.ts");
      await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      const html = await response.text();
      // The radio for the previously-saved answer is pre-checked.
      expect(html).toContain(
        `<input checked name="question_${q.id}" type="radio" value="${a1.id}">`,
      );
    });

    test("does not show questions when listing has none", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Jane Doe",
        "jane@example.com",
      );
      const response = await adminGet(`/admin/attendees/${attendee.id}`);
      const html = await response.text();
      expect(html).not.toContain("custom-question");
    });

    test("saves selected answer on edit", async () => {
      const { attendee, q, a2 } = await setupQuestionAndAttendee();
      const form = await buildAttendeeEditForm(attendee.id, {
        email: "john@example.com",
        extra: { [`question_${q.id}`]: String(a2.id) },
        name: "John Doe",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);

      const { getAttendeeAnswersBatch } = await import(
        "#shared/db/questions.ts"
      );
      const answers = await getAttendeeAnswersBatch([attendee.id], {
        texts: false,
      });
      expect(answers.get(attendee.id)).toEqual([a2.id]);
    });

    test("updates answer from one option to another", async () => {
      const { attendee, q, a1, a2 } = await setupQuestionAndAttendee();
      const { saveAttendeeAnswers, getAttendeeAnswersBatch } = await import(
        "#shared/db/questions.ts"
      );
      await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

      const form = await buildAttendeeEditForm(attendee.id, {
        email: "john@example.com",
        extra: { [`question_${q.id}`]: String(a2.id) },
        name: "John Doe",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);

      const answers = await getAttendeeAnswersBatch([attendee.id], {
        texts: false,
      });
      expect(answers.get(attendee.id)).toEqual([a2.id]);
    });

    test("clears answers when no question field submitted", async () => {
      const { attendee, a1 } = await setupQuestionAndAttendee();
      const { saveAttendeeAnswers, getAttendeeAnswersBatch } = await import(
        "#shared/db/questions.ts"
      );
      await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

      const form = await buildAttendeeEditForm(attendee.id, {
        email: "john@example.com",
        name: "John Doe",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);

      const answers = await getAttendeeAnswersBatch([attendee.id], {
        texts: false,
      });
      const attendeeAnswers = answers.get(attendee.id) ?? [];
      expect(attendeeAnswers.length).toBe(0);
    });

    test("ignores invalid answer ID for question", async () => {
      const { attendee, q } = await setupQuestionAndAttendee();

      const form = await buildAttendeeEditForm(attendee.id, {
        email: "john@example.com",
        extra: { [`question_${q.id}`]: "99999" },
        name: "John Doe",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);

      const { getAttendeeAnswersBatch } = await import(
        "#shared/db/questions.ts"
      );
      const answers = await getAttendeeAnswersBatch([attendee.id], {
        texts: false,
      });
      const attendeeAnswers = answers.get(attendee.id) ?? [];
      expect(attendeeAnswers.length).toBe(0);
    });
  });

  describe("GET /admin/attendees/:attendeeId/merge", () => {
    testRequiresAuth("/admin/attendees/1/merge", {
      setup: async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("returns 404 for non-existent attendee", async () => {
      const response = await adminGet("/admin/attendees/999/merge");
      expect(response.status).toBe(404);
    });

    test("shows search form without token param", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "John Doe",
        "john@example.com",
      );
      const response = await adminGet(`/admin/attendees/${attendee.id}/merge`);
      await expectHtmlResponse(
        response,
        200,
        "Merge Attendee",
        "Search by Ticket Token",
      );
    });

    test("shows error when token not found", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "John Doe",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/merge?token=invalid-token`,
      );
      await expectHtmlResponse(response, 200, "not found");
    });

    test("shows error when token matches same attendee", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee, token } = await createTestAttendeeDirect(
        listing.id,
        "John Doe",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/merge?token=${encodeURIComponent(
          token,
        )}`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Cannot merge an attendee with themselves",
      );
    });

    test("shows merge preview when valid source token provided", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing.id,
        "John Smith",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Merge Preview",
        "Jane Doe",
        "John Smith",
        "Merge and Delete Source Attendee",
      );
    });
  });

  /** Extract merge_version from the merge preview HTML page */
  const getMergeVersion = async (
    targetId: number,
    sourceToken: string,
  ): Promise<string> => {
    const page = await adminGet(
      `/admin/attendees/${targetId}/merge?token=${encodeURIComponent(
        sourceToken,
      )}`,
    );
    const html = await page.text();
    const value = extractInputValue(html, "merge_version");
    if (value === null) throw new Error("merge_version not found in page");
    return value;
  };

  describe("POST /admin/attendees/:attendeeId/merge", () => {
    testRequiresAuth("/admin/attendees/1/merge", {
      body: {
        source_token: "some-token",
      },
      method: "POST",
      setup: async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        await createTestAttendeeDirect(
          listing.id,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("returns 404 for non-existent target attendee", async () => {
      const { response } = await adminFormPost("/admin/attendees/999/merge", {
        source_token: "some-token",
      });
      expect(response.status).toBe(404);
    });

    test("rejects missing source_token", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/merge`,
        {},
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Source token"), false);
    });

    test("rejects invalid source token", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/merge`,
        { source_token: "nonexistent-token" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("not found"), false);
    });

    test("rejects self-merge", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee, token } = await createTestAttendeeDirect(
        listing.id,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/merge`,
        { source_token: token },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Cannot merge an attendee with themselves"),
        false,
      );
    });

    test("merges source listings into target and deletes source", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "Listing One",
      });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "Listing Two",
      });

      const { attendee: target } = await createTestAttendeeDirect(
        listing1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken, attendee: source } =
        await createTestAttendeeDirect(
          listing2.id,
          "John Smith",
          "john@example.com",
        );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        { merge_version: mergeVersion, source_token: sourceToken },
      );

      await expectFlashRedirect(
        `/admin/attendees/${target.id}`,
        expect.stringContaining("Merged"),
      )(response);

      // Source attendee should be deleted
      const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
      const deleted = await getAttendeeRaw(source.id);
      expect(deleted).toBeNull();

      // Target should still exist
      const surviving = await getAttendeeRaw(target.id);
      expect(surviving).not.toBeNull();

      // Target should now have both listing links
      const m = await import("#shared/db/client.ts");
      const targetListingLinks = await m.queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
        [target.id],
      );
      const listingIds = targetListingLinks.map((r) => r.listing_id).sort();
      expect(listingIds).toEqual([listing1.id, listing2.id].sort());
    });

    test("keeps target PII when no source fields selected", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
        1,
        "555-1111",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
        1,
        "555-9999",
      );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      // Submit without choosing source for any field (all default to target)
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        { merge_version: mergeVersion, source_token: sourceToken },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);

      // Verify target PII is preserved
      const getPage = await adminGet(`/admin/attendees/${target.id}`);
      await expectHtmlResponse(getPage, 200, "Jane Doe", "jane@example.com");
    });

    test("takes source PII fields when selected", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
        1,
        "555-1234",
        "123 Source St",
        "Source instructions",
      );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      // Choose source for all PII fields
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          pii_address: "source",
          pii_email: "source",
          pii_name: "source",
          pii_phone: "source",
          pii_special_instructions: "source",
          source_token: sourceToken,
        },
      );
      expect(response.status).toBe(302);

      // Verify target now has source's PII
      const getPage = await adminGet(`/admin/attendees/${target.id}`);
      await expectHtmlResponse(
        getPage,
        200,
        "John Smith",
        "john@example.com",
        "555-1234",
        "123 Source St",
        "Source instructions",
      );
    });

    test("skips conflicting listing booking during merge", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      // Both attendees are registered for the same listing
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken, attendee: source } =
        await createTestAttendeeDirect(
          listing.id,
          "John Smith",
          "john@example.com",
        );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      // Booking conflict: same listing, same start_at (null) — choose keep_target
      const bookingKey = `${listing.id}:null:0`;
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`booking_${bookingKey}`]: "keep_target",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);

      // Source deleted
      const { getAttendeeRaw } = await import("#shared/db/attendees.ts");
      expect(await getAttendeeRaw(source.id)).toBeNull();

      // Target still has exactly one link to the listing (conflict was skipped)
      const { queryAll } = await import("#shared/db/client.ts");
      const links = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(links.length).toBe(1);
      expect(links[0]!.listing_id).toBe(listing.id);
    });
  });

  describe("GET /admin/attendees/:attendeeId/merge (coverage branches)", () => {
    test("shows merge preview with multiline field differences (address differs)", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
        1,
        "",
        "123 Main St",
        "No nuts",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
        1,
        "",
        "456 Oak Ave",
        "Gluten free",
      );
      const response = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      // Multiline fields (address, special_instructions) differ — exercises renderFieldValue(val, true) with same=false
      await expectHtmlResponse(response, 200, "456 Oak Ave", "Gluten free");
    });

    test("shows merge preview when source has empty phone but target does not", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
        1,
        "555-1234",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      // Source has no phone — exercises sourceValue || "—" branch
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      await expectHtmlResponse(response, 200, "Merge Preview");
    });

    test("shows merge preview when source and target have empty email", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      // Empty email covers the `email || ""` branches on both target and source
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "",
      );
      const response = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      await expectHtmlResponse(response, 200, "Merge Preview");
    });

    test("shows daily listing start_at date in source bookings list", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const dailyListing = await createTestListing({
        listingType: "daily",
        maxAttendees: 50,
        name: "Daily E",
      });
      const result = await bookAttendee(dailyListing, {
        date: "2026-05-01",
        email: "john@example.com",
        name: "John Smith",
      });
      if (!result.success) throw new Error("createAttendeeAtomic failed");
      const sourceToken = result.attendees[0]!.ticket_token;

      const response = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      // start_at is set for daily listings — exercises the b.start_at ? `— date` : "" branch
      await expectHtmlResponse(response, 200, "2026-05-01");
    });

    test("shows moveable booking row without decision column when no conflicts", async () => {
      const listing1 = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });

      const { attendee: target } = await createTestAttendeeDirect(
        listing1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );

      const response = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      // All bookings are moveable (different listings) — no Decision column rendered
      await expectHtmlResponse(response, 200, "Will be moved");
    });

    test("shows duplicate booking status when same listing with identical metadata", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing.id,
        "John Smith",
        "john@example.com",
      );

      const response = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      // Same listing, same qty/price/checked_in/refunded — classified as "duplicate"
      await expectHtmlResponse(response, 200, "Duplicate");
    });
  });

  describe("merge with answer conflicts", () => {
    test("GET merge page renders answer decision table when conflicts exist", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Favourite colour?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Blue",
      });
      await setListingQuestions(listing.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      await setListingQuestions(listing2.id, [q.id]);
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );

      // Assign different answers
      const { saveAttendeeAnswers: save } = await import(
        "#shared/db/questions.ts"
      );
      await save(new Map([[target.id, [a1.id]]]));
      // Need source attendee ID
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save(new Map([[sourceData!.id, [a2.id]]]));

      const response = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Custom Question Answers",
        "Favourite colour?",
      );
    });

    test("POST merge applies selected answer winners", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });
      await setListingQuestions(listing.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      await setListingQuestions(listing2.id, [q.id]);
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );

      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#shared/db/questions.ts");
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save(new Map([[target.id, [a1.id]]])); // Small
      await save(new Map([[sourceData!.id, [a2.id]]])); // Large

      // Get merge version from preview page
      const previewPage = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      const previewHtml = await previewPage.text();
      const mergeVersion = extractInputValue(previewHtml, "merge_version")!;

      // Submit choosing source answer
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`answer_${q.id}`]: "source",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);

      // Verify target now has source's answer (Large)
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(q.id)?.answerId).toBe(a2.id);
    });

    test("POST merge reports skipped bookings in flash", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing.id,
        "John Smith",
        "john@example.com",
      );

      // Get merge version
      const previewPage = await adminGet(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      const html = await previewPage.text();
      const mergeVersion = extractInputValue(html, "merge_version")!;

      const bookingKey = `${listing.id}:null:0`;
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`booking_${bookingKey}`]: "skip_source",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("1 booking(s) skipped"),
        true,
      );
    });

    test("stale preview version rejected", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });

      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );

      // Submit with wrong version — should get validation error (200 response)
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: "stale-version",
          source_token: sourceToken,
        },
      );
      // Validation error renders the merge page (200) with error message
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("out of date");
    });

    test("POST merge with clear answer choice clears the answer", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Diet?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Vegan",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Keto",
      });
      await setListingQuestions(listing.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      await setListingQuestions(listing2.id, [q.id]);
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );

      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#shared/db/questions.ts");
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save(new Map([[target.id, [a1.id]]]));
      await save(new Map([[sourceData!.id, [a2.id]]]));

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`answer_${q.id}`]: "clear",
        },
      );
      expect(response.status).toBe(302);

      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.has(q.id)).toBe(false);
    });

    test("POST merge with target answer choice keeps target answer", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Shirt?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "M",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "L",
      });
      await setListingQuestions(listing.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      await setListingQuestions(listing2.id, [q.id]);
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );

      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#shared/db/questions.ts");
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save(new Map([[target.id, [a1.id]]]));
      await save(new Map([[sourceData!.id, [a2.id]]]));

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`answer_${q.id}`]: "target",
        },
      );
      expect(response.status).toBe(302);

      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
    });

    test("POST merge auto-adopts source-only non-conflicting answer", async () => {
      const listing1 = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Colour?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Green",
      });
      await setListingQuestions(listing1.id, [q.id]);
      await setListingQuestions(listing2.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        listing1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );

      // Only source has an answer — no conflict
      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#shared/db/questions.ts");
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save(new Map([[sourceData!.id, [a1.id]]]));

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
        },
      );
      expect(response.status).toBe(302);

      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
    });

    test("POST merge keeps target-only non-conflicting answer", async () => {
      const listing1 = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Food?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Pizza",
      });
      await setListingQuestions(listing1.id, [q.id]);
      await setListingQuestions(listing2.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        listing1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );

      // Only target has an answer — no conflict
      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#shared/db/questions.ts");
      await save(new Map([[target.id, [a1.id]]]));

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
        },
      );
      expect(response.status).toBe(302);

      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
    });

    test("POST merge with take_source replaces target booking", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing.id,
        "John Smith",
        "john@example.com",
      );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const bookingKey = `${listing.id}:null:0`;
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`booking_${bookingKey}`]: "take_source",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);
    });
  });
});
