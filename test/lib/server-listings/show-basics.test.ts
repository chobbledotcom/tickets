// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { updateListingAggregateValues } from "#shared/db/listings.ts";
import {
  assertAdminHtml,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { postAttendeeRefund, postListingSale } from "#test-utils/ledger.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminGet,
  createTestManagerSession,
  setupListingAndLogin,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > show basics", { db: true }, () => {
  describe("GET /admin/listing/:id", () => {
    testRequiresAuth("/admin/listing/1");

    /** Fetches a listing's detail page HTML with an authenticated cookie —
     *  shared by the income & ledger checks below. */
    const getListingDetailHtml = async (
      listingId: number,
      cookie: string,
    ): Promise<string> => {
      const response = await awaitTestRequest(`/admin/listing/${listingId}`, {
        cookie,
      });
      return response.text();
    };

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999");
      expect(response.status).toBe(404);
    });

    test("shows listing details when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      await assertAdminHtml("/admin/listing/1", listing.name);
    });

    test("renders the income & ledger breakdown reconciling income with the balance", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Ledger Listing",
        thankYouUrl: "https://example.com",
      });
      const buyer = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      // A £50 sale, then a refunded £20 booking (postAttendeeRefund posts a
      // self-contained net-zero order — a sale plus its full reversal). So gross
      // credits total £70 and recognised income is £70 (refund-agnostic), while
      // the net ledger balance is £50 once the £20 refund_sale debit is netted —
      // a legitimate divergence the page must show reconciled.
      await postListingSale({
        attendeeId: buyer.id,
        gross: 5000,
        listingId: listing.id,
      });
      await postAttendeeRefund({
        attendeeId: buyer.id,
        gross: 2000,
        listingId: listing.id,
      });

      const html = await getListingDetailHtml(listing.id, cookie);
      expect(html).toContain("Money in and out");
      expect(html).toContain("Gross ticket sales");
      expect(html).toContain("Total income earned");
      expect(html).toContain("Net after refunds and costs");
      // Recognised income £70 differs from the net ledger balance £50 by the £20
      // refund — both rendered, reconciled.
      expect(html).toContain("£70");
      expect(html).toContain("£50");
      expect(html).toContain("−£20");
      expect(html).toContain(`href="/admin/ledger?listing=${listing.id}"`);
    });

    test("does not eagerly render the full revenue statement on listing detail pages", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Busy Listing",
        thankYouUrl: "https://example.com",
      });
      const buyer = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      await postListingSale({
        attendeeId: buyer.id,
        gross: 5000,
        listingId: listing.id,
      });

      const html = await getListingDetailHtml(listing.id, cookie);
      expect(html).toContain("Money in and out");
      expect(html).toContain(`href="/admin/ledger?listing=${listing.id}"`);
      expect(html).not.toContain('<section id="ledger">');
      expect(html).not.toContain("Money history");
      expect(html).not.toContain("<th>Other side</th>");
    });

    test("does not offer managers a forbidden ledger link", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Manager Listing",
      });
      const html = await getListingDetailHtml(
        listing.id,
        await createTestManagerSession(),
      );
      expect(html).toContain("Money in and out");
      expect(html).not.toContain(`/admin/ledger?listing=${listing.id}`);
    });

    test("shows stored-total mismatches on listing detail and edit pages", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Mismatch Listing",
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Actual User",
        "actual@example.com",
        2,
      );
      await updateListingAggregateValues(listing.id, {
        booked_quantity: 9,
        tickets_count: 1,
      });

      const detail = await adminGet(`/admin/listing/${listing.id}`);
      await expectHtmlResponse(
        detail,
        200,
        "Running total check",
        "expected <strong>1</strong>, got",
        "Review and recalculate totals",
      );

      const edit = await adminGet(`/admin/listing/${listing.id}/edit`);
      await expectHtmlResponse(
        edit,
        200,
        "Running totals",
        "expected <strong>1</strong>, got",
        "Review and recalculate totals",
      );
    });

    test("shows Edit link on listing page", async () => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/listing/1", {
        cookie: cookie,
      });
      const html = await response.text();
      expect(html).toContain("/admin/listing/1/edit");
      expect(html).toContain(">Edit<");
    });
  });
});
