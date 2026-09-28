// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
// jscpd:ignore-end
import type { AttendeeInput } from "#db/attendee-types.ts";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { handleRequest } from "#routes";
import { addMonthsIso } from "#shared/dates.ts";
import { nowIso } from "#shared/now.ts";
import {
  adminAttendeeAction,
  setupAdminTest,
} from "#test-utils/admin-fixture.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  followRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminFormPost } from "#test-utils/session.ts";
import type { Attendee } from "#types";
import { stubEdgeSecretSuccess } from "../site-assignment-shared.ts";

describeWithEnv(
  "server (admin attendees) > resend notification",
  { db: true },
  () => {
    describe("POST /admin/attendees/:attendeeId/resend-notification", () => {
      const resendNotificationAction = adminAttendeeAction(
        "resend-notification",
      );

      /** One new attendee booked with `bookings`, for tests that resend the
       * notification themselves. */
      const firstBookedAttendee = async (
        bookings: AttendeeInput["bookings"],
        name: string,
        email: string,
      ): Promise<Attendee> => {
        const { attendeesApi } = await import("#db/attendees/api.ts");
        const result = await attendeesApi.createAttendeeAtomic({
          bookings,
          email,
          name,
        });
        if (!result.success) throw new Error("booking failed");
        return result.attendees[0]!;
      };

      /** Book one new attendee, resend their notification, and return the
       * registration webhook's ticket lines. No wait is needed: handleRequest
       * flushes pending work (the fire-and-forget webhook) in its finally
       * before returning the response, so the dispatch has completed. */
      const resendTickets = async (
        bookings: AttendeeInput["bookings"],
        name: string,
        email: string,
      ): Promise<{ listing_name: string; quantity: number }[]> => {
        const attendee = await firstBookedAttendee(bookings, name, email);
        using webhookFetch = stubFetch(new Response());
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}/resend-notification`,
          { confirm_identifier: name },
        );
        expect(response.status).toBe(302);
        expect(webhookFetch.calls.length).toBe(1);
        const [, options] = webhookFetch.calls[0]!.args as [
          string,
          RequestInit,
        ];
        const body = JSON.parse(options.body as string) as {
          tickets: { listing_name: string; quantity: number }[];
        };
        return body.tickets;
      };

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
        const tickets = await resendTickets(
          [
            { listingId: memberA.id, packageGroupId: group.id, quantity: 1 },
            { listingId: memberB.id, packageGroupId: group.id, quantity: 2 },
          ],
          "Duo Buyer",
          "duo@example.com",
        );
        // BOTH package lines ride the resend, with their own quantities.
        expect(tickets).toHaveLength(2);
        const byName = new Map(
          tickets.map((t) => [t.listing_name, t.quantity]),
        );
        expect(byName.get("Duo A")).toBe(1);
        expect(byName.get("Duo B")).toBe(2);
      });

      test("a standalone multi-booking resend rehydrates every booked line", async () => {
        // A standalone attendee with several bookings is not one line: the
        // resend must carry every line, or the site assignment reads one
        // plan's months against another line's quantity — or misses a plan
        // line entirely.
        const soloA = await createTestListing({
          name: "Solo A",
          webhookUrl: "https://example.com/webhook",
        });
        const soloB = await createTestListing({ name: "Solo B" });
        const tickets = await resendTickets(
          [
            { listingId: soloA.id, quantity: 1 },
            { listingId: soloB.id, quantity: 2 },
          ],
          "Solo Buyer",
          "solo@example.com",
        );
        expect(tickets).toHaveLength(2);
        const byName = new Map(
          tickets.map((t) => [t.listing_name, t.quantity]),
        );
        expect(byName.get("Solo A")).toBe(1);
        expect(byName.get("Solo B")).toBe(2);
      });

      test("a package resend never notifies another package or a standalone line", async () => {
        // One attendee can hold several purchases. The selected package
        // member's resend rehydrates ITS package alone — never the lines of
        // another package on the same attendee.
        const { createTestGroup } = await import(
          "#test-utils/db-helpers/groups.ts"
        );
        const duo = await createTestGroup({
          isPackage: true,
          name: "Duo Kit",
        });
        const trio = await createTestGroup({
          isPackage: true,
          name: "Trio Kit",
        });
        const duoA = await createTestListing({
          groupId: duo.id,
          name: "Duo A",
          webhookUrl: "https://example.com/webhook",
        });
        const duoB = await createTestListing({
          groupId: duo.id,
          name: "Duo B",
        });
        const trioC = await createTestListing({
          groupId: trio.id,
          name: "Trio C",
        });
        const solo = await createTestListing({ name: "Solo S" });
        const tickets = await resendTickets(
          [
            { listingId: duoA.id, packageGroupId: duo.id, quantity: 1 },
            { listingId: duoB.id, packageGroupId: duo.id, quantity: 2 },
            { listingId: trioC.id, packageGroupId: trio.id, quantity: 3 },
            { listingId: solo.id, quantity: 1 },
          ],
          "Multi Buyer",
          "multi@example.com",
        );
        const names = tickets.map((t) => t.listing_name).sort();
        // The selected booking is the duo's first member (lowest listing id),
        // so the resend carries exactly the duo package.
        expect(names).toEqual(["Duo A", "Duo B"]);
      });

      test("a standalone resend never notifies a package's lines", async () => {
        // The mirror half: resending a standalone line leaves every package
        // of the same attendee to its own members' resends.
        const { createTestGroup } = await import(
          "#test-utils/db-helpers/groups.ts"
        );
        const duo = await createTestGroup({
          isPackage: true,
          name: "Duo Kit",
        });
        const solo = await createTestListing({
          name: "Solo S",
          webhookUrl: "https://example.com/webhook",
        });
        const duoA = await createTestListing({
          groupId: duo.id,
          name: "Duo A",
        });
        const duoB = await createTestListing({
          groupId: duo.id,
          name: "Duo B",
        });
        const tickets = await resendTickets(
          [
            { listingId: solo.id, quantity: 1 },
            { listingId: duoA.id, packageGroupId: duo.id, quantity: 2 },
            { listingId: duoB.id, packageGroupId: duo.id, quantity: 3 },
          ],
          "Mixed Buyer",
          "mixed@example.com",
        );
        // The selected booking is the standalone line (lowest listing id).
        expect(tickets.map((t) => t.listing_name)).toEqual(["Solo S"]);
      });

      test("a resend assigns the site a later plan line bought", async () => {
        // The out-of-stock repair tells the operator to resend from the
        // attendee page. The attendee page loads the FIRST booking, which
        // here is a non-plan line — the resend must still reach the plan
        // line that bought the site. The plan listing is created under the
        // builder flag: its form field only parses when that view is on.
        using _builder = withEnv({ CAN_BUILD_SITES: "true" });
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          purchaseOnly: true,
          unitPrice: 500,
        });
        const plan = await createTestListing({
          assignBuiltSite: true,
          hidden: true,
          initialSiteMonths: 3,
          name: "Site Plan",
          purchaseOnly: true,
          unitPrice: 500,
        });
        const plain = await createTestListing({ name: "Plain Entry" });
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");
        using _secret = stubEdgeSecretSuccess();
        using _fetch = stubFetch(() => new Response());

        const attendee = await firstBookedAttendee(
          [
            { listingId: plain.id, quantity: 1 },
            { listingId: plan.id, quantity: 2 },
          ],
          "Later Buyer",
          "later@example.com",
        );
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}/resend-notification`,
          { confirm_identifier: "Later Buyer" },
        );
        expect(response.status).toBe(302);

        const sites = await builtSites.getAll();
        const assigned = sites.find((s) => s.assignedAttendeeId !== null)!;
        expect(assigned.assignedListingId).toBe(plan.id);
        // Two units of the 3-month plan buy 6 months.
        expect(assigned.readOnlyFrom.slice(0, 10)).toBe(
          addMonthsIso(nowIso(), 6).slice(0, 10),
        );
      });
    });
  },
);
