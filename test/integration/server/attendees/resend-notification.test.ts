// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
// jscpd:ignore-end
import { setupListingAndAttendee } from "#test/test-utils/attendees/helpers.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  followRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminAttendeeAction,
  adminFormPost,
  adminGet,
  adminListingPage,
  setupAdminTest,
} from "#test-utils/session.ts";

describeWithEnv(
  "server (admin attendees) > resend notification",
  { db: true },
  () => {
    describe("GET /admin/attendees/:attendeeId/resend-notification", () => {
      testRequiresAuth("/admin/attendees/1/resend-notification", {
        setup: async () => {
          await setupListingAndAttendee();
        },
      });

      test("returns 404 for non-existent listing", async () => {
        const response = await adminGet(
          "/admin/attendees/1/resend-notification",
        );
        expect(response.status).toBe(404);
      });

      test("returns 404 for non-existent attendee", async () => {
        await setupListingAndAttendee();

        const response = await adminGet(
          "/admin/attendees/999/resend-notification",
        );
        expect(response.status).toBe(404);
      });

      test("shows resend notification confirmation page when authenticated", async () => {
        const { response } = await adminListingPage(
          (ctx) => `/admin/attendees/${ctx.attendee.id}/resend-notification`,
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
            `/admin/attendees/${ctx.attendee.id}/resend-notification?return_url=${encodeURIComponent(
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
          `/admin/attendees/${result.attendees[0]!.id}/resend-notification`,
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

    describe("POST /admin/attendees/:attendeeId/resend-notification", () => {
      const resendNotificationAction = adminAttendeeAction(
        "resend-notification",
      );

      testRequiresAuth("/admin/attendees/1/resend-notification", {
        body: {
          confirm_identifier: "John Doe",
        },
        method: "POST",
        setup: async () => {
          await setupListingAndAttendee();
        },
      });

      test("returns 404 for non-existent listing", async () => {
        const { response } = await adminFormPost(
          "/admin/attendees/1/resend-notification",
          { confirm_identifier: "John Doe" },
        );
        expect(response.status).toBe(404);
      });

      test("returns 404 for non-existent attendee", async () => {
        await createTestListing({ maxAttendees: 100 });

        const { response } = await adminFormPost(
          "/admin/attendees/999/resend-notification",
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

      test("shows the mismatch error on the page after following the redirect", async () => {
        const { attendee, cookie, csrfToken } = await setupAdminTest();
        const postResponse = await handleRequest(
          mockFormRequest(
            `/admin/attendees/${attendee.id}/resend-notification`,
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

      test("re-sends notification with matching name", async () => {
        using webhookFetch = stubFetch(new Response());
        const { response, attendee } = await resendNotificationAction({
          confirm_identifier: "John Doe",
        })({
          webhookUrl: "https://example.com/webhook",
        });
        expect(response.status).toBe(302);
        await expectFlashRedirect(
          `/admin/attendees/${attendee.id}/actions`,
          "Notification re-sent",
        )(response);

        // Verify webhook was sent
        expect(webhookFetch.calls.length).toBeGreaterThan(0);
      });

      test("logs activity when notification is re-sent", async () => {
        using _fetch = stubFetch(new Response());
        const { response, listing } = await resendNotificationAction({
          confirm_identifier: "John Doe",
        })({
          webhookUrl: "https://example.com/webhook",
        });
        expect(response.status).toBe(302);

        // Verify activity was logged
        const { getListingActivityLog } = await import(
          "#test-utils/activity-log.ts"
        );
        const logs = await getListingActivityLog(listing.id);
        const resendLog = logs.find((l: { message: string }) =>
          l.message.includes("Notification re-sent"),
        );
        expect(resendLog).toBeDefined();
        expect(resendLog?.message).toContain("John Doe");
      });

      test("a package member's resend rehydrates every line of the package", async () => {
        // The resend selects ONE member row, but the notification must carry
        // the attendee's whole package — otherwise a hidden package's
        // confirmation collapses to that single row's quantity/price.
        const { createTestGroup } = await import(
          "#test-utils/db-helpers/groups.ts"
        );
        const { attendeesApi } = await import("#shared/db/attendees/api.ts");
        const group = await createTestGroup({
          isPackage: true,
          name: "Duo Kit",
        });
        const memberA = await createTestListing({
          groupId: group.id,
          name: "Duo A",
          webhookUrl: "https://example.com/webhook",
        });
        const memberB = await createTestListing({
          groupId: group.id,
          name: "Duo B",
        });
        const result = await attendeesApi.createAttendeeAtomic({
          bookings: [
            { listingId: memberA.id, packageGroupId: group.id, quantity: 1 },
            { listingId: memberB.id, packageGroupId: group.id, quantity: 2 },
          ],
          email: "duo@example.com",
          name: "Duo Buyer",
        });
        if (!result.success) throw new Error("package booking failed");

        using webhookFetch = stubFetch(new Response());
        const { response } = await adminFormPost(
          `/admin/attendees/${result.attendees[0]!.id}/resend-notification`,
          { confirm_identifier: "Duo Buyer" },
        );
        expect(response.status).toBe(302);
        // No wait needed: handleRequest flushes pending work (the
        // fire-and-forget webhook) in its finally before returning the
        // response, so the dispatch has already completed by here.
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
      });
    });
  },
);
