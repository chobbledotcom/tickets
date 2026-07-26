// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatCountdown } from "#routes/format.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { nowMs } from "#shared/now.ts";
import { assertAdminHtml, expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > closes_at field", { db: true }, () => {
  describe("closes_at field", () => {
    test("creates listing with closes_at timestamp", async () => {
      const closesAt = "2099-06-15T14:30";
      const listing = await createTestListing({ closesAt });

      const saved = await getListingWithCount(listing.id);
      expect(saved?.closes_at).toBe("2099-06-15T14:30:00.000Z");
    });

    test("creates listing without closes_at (defaults to null)", async () => {
      const listing = await createTestListing();

      const saved = await getListingWithCount(listing.id);
      expect(saved?.closes_at).toBeNull();
    });

    test("updates listing closes_at", async () => {
      const listing = await createTestListing();
      const closesAt = "2099-12-31T23:59";
      await updateTestListing(listing.id, { closesAt });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.closes_at).toBe("2099-12-31T23:59:00.000Z");
    });

    test("clears closes_at by setting to empty string", async () => {
      const listing = await createTestListing({ closesAt: "2099-06-15T14:30" });
      await updateTestListing(listing.id, { closesAt: "" });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.closes_at).toBeNull();
    });

    test("admin listing detail page shows closes_at with countdown when set", async () => {
      const { listing } = await setupListingAndLogin({
        closesAt: "2099-06-15T14:30",
      });

      const html = await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Registration Closes",
        "from now",
      );
      expect(html).not.toContain("No deadline");
    });

    test("admin listing detail page shows 'No deadline' when closes_at is null", async () => {
      const { listing } = await setupListingAndLogin();

      await assertAdminHtml(`/admin/listing/${listing.id}`, "No deadline");
    });

    test("admin listing edit page shows closes_at in form", async () => {
      const { listing } = await setupListingAndLogin({
        closesAt: "2099-06-15T14:30",
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        'value="2099-06-15"',
        'value="14:30"',
        "Registration Closes At",
      );
    });

    test("admin listing detail page shows 'closed' countdown for past closes_at", async () => {
      const { listing } = await setupListingAndLogin({
        closesAt: "2024-01-01T00:00",
      });

      await assertAdminHtml(`/admin/listing/${listing.id}`, "(closed)");
    });

    /** Creates a listing that closes `offsetMs` from now and expects its
     *  admin detail page's countdown to contain `expectedText` — shared by
     *  the days/hours/minutes-only countdown checks below. */
    const expectCountdownText = async (
      offsetMs: number,
      expectedText: string,
    ): Promise<void> => {
      const future = new Date(Date.now() + offsetMs);
      const closesAt = future.toISOString().slice(0, 16);
      const listing = await createTestListing({ closesAt });

      const response = await adminGet(`/admin/listing/${listing.id}`);
      await expectHtmlResponse(response, 200, expectedText);
    };

    test("admin listing detail page shows days-only countdown", async () => {
      await expectCountdownText(
        3 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000,
        "days from now",
      );
    });

    test("admin listing detail page shows hours-only countdown", async () => {
      await expectCountdownText(
        5 * 60 * 60 * 1000 + 10 * 60 * 1000,
        "hours from now",
      );
    });

    test("admin listing detail page shows minutes-only countdown", async () => {
      await expectCountdownText(30 * 60 * 1000, "minute");
    });

    test("formatCountdown shows days and hours", () => {
      const future = new Date(
        nowMs() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000 + 30 * 60 * 1000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("3 days and 5 hours from now");
    });

    test("formatCountdown shows only days when no remaining hours", () => {
      const future = new Date(
        nowMs() + 2 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("2 days from now");
    });

    test("formatCountdown shows only hours", () => {
      const future = new Date(
        nowMs() + 5 * 60 * 60 * 1000 + 10 * 60 * 1000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("5 hours from now");
    });

    test("formatCountdown shows minutes when less than an hour", () => {
      const result = formatCountdown(
        new Date(nowMs() + 30 * 60 * 1000).toISOString(),
      );
      expect(result).toContain("minute");
      expect(result).toContain("from now");
    });

    test("formatCountdown shows closed for past dates", () => {
      expect(formatCountdown("2024-01-01T00:00:00.000Z")).toBe("closed");
    });

    test("formatCountdown singular forms", () => {
      // Add 30s buffer so elapsed time between nowMs() calls doesn't push hours below boundary
      const future = new Date(
        nowMs() + 1 * 24 * 60 * 60 * 1000 + 1 * 60 * 60 * 1000 + 30_000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("1 day and 1 hour from now");
    });

    test("rejects invalid closes_at format", async () => {
      const { listing } = await setupListingAndLogin();

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          closes_at_date: "not-a-date",
          closes_at_time: "99:99",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
        },
      );
      await expectHtmlResponse(
        response,
        400,
        "Please enter a valid date and time",
      );
    });
  });
});
