import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { deleteListing } from "#db/listings/delete.ts";
import { handleRequest } from "#routes";
import {
  attendeeActionUrlWithReturn,
  getReturnUrl,
} from "#routes/admin/attendees-route-helpers.ts";
import { setupRefundTest } from "#test/features/admin/refunds-helpers.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import { statementSql, wrapDbClient } from "#test-utils/record-queries.ts";
import { refundUrl } from "#test-utils/refund-routes.ts";

describeWithEnv("admin attendee action loaders", { db: true }, () => {
  test("keeps a return address in attendee action URLs only when one exists", () => {
    expect(
      attendeeActionUrlWithReturn(7, "refund", "/admin/calendar#paid"),
    ).toBe("/admin/attendees/7/refund?return_url=%2Fadmin%2Fcalendar%23paid");
    expect(attendeeActionUrlWithReturn(7, "refund", "")).toBe(
      "/admin/attendees/7/refund",
    );
    expect(
      getReturnUrl(
        new Request(
          "https://example.test/admin?return_url=%2Fadmin%2Fcalendar",
        ),
      ),
    ).toBe("/admin/calendar");
  });

  test("returns 404 when the chosen listing disappears during the load", async () => {
    const ctx = await setupRefundTest("pi_listing_deleted_during_load");
    const realDb = getDb();
    let removed = false;
    const restoreDb = wrapDbClient({
      batch: () => {},
      execute: (statement) => {
        if (
          removed ||
          !statementSql(statement).includes("SELECT listingAttendee.listing_id")
        ) {
          return null;
        }
        removed = true;
        return (async () => {
          const selected = await realDb.execute(statement);
          await deleteListing(ctx.listing.id);
          return selected;
        })();
      },
    });

    try {
      const response = await awaitTestRequest(refundUrl(ctx.attendee.id), {
        cookie: ctx.cookie,
      });
      expect(response.status).toBe(404);
    } finally {
      restoreDb();
    }
    expect(removed).toBe(true);
  });

  test("renders a guarded attendee action as a bad request", async () => {
    const ctx = await setupRefundTest("pi_moving_get");
    await claimCurrentAttendeeRows([ctx.attendee.id]);

    const response = await awaitTestRequest(refundUrl(ctx.attendee.id), {
      cookie: ctx.cookie,
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("Refresh payment status");
    expect(html).not.toContain("Refund Attendee</button>");
    expect(html).not.toContain('name="confirm_identifier"');
  });

  test("names the attendee field and preserves the return address on a refused confirmation", async () => {
    const ctx = await setupRefundTest("pi_test_789");
    const returnUrl = "/admin/calendar#paid";
    const response = await handleRequest(
      mockFormRequest(
        refundUrl(ctx.attendee.id),
        {
          confirm_identifier: "Wrong Name",
          csrf_token: ctx.csrfToken,
          return_url: returnUrl,
        },
        ctx.cookie,
      ),
    );

    await expectFlashRedirect(
      attendeeActionUrlWithReturn(ctx.attendee.id, "refund", returnUrl),
      "Attendee name does not match. Please type the exact attendee name to confirm refund.",
      false,
    )(response);
  });
});
