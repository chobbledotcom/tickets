import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  mockRequest,
} from "#test-utils";

const get = (path: string) => handleRequest(mockRequest(path));

const DAILY = {
  bookableDays: ["Monday", "Tuesday", "Wednesday"],
  listingType: "daily" as const,
  maximumDaysAfter: 14,
  minimumDaysBefore: 0,
};

describeWithEnv("server (public listings type filter)", { db: true }, () => {
  describe("filtering", () => {
    beforeEach(async () => {
      await settings.update.showPublicSite(true);
    });

    test("shows the type filter when more than one type is present", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Daily One", ...DAILY });
      const html = await expectHtmlResponse(
        await get("/listings"),
        200,
        "Showing:",
        "Standard",
        "Daily",
      );
      expect(html).toContain('href="/listings?filter=standard"');
    });

    test("hides the type filter when only one type is present", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Standard Two" });
      const html = await expectHtmlResponse(await get("/listings"), 200);
      expect(html).not.toContain("Showing:");
    });

    test("filters to standard listings and hides other types and groups", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Daily One", ...DAILY });
      const group = await createTestGroup({ name: "Group One", slug: "grp" });
      await createTestListing({ groupId: group.id, name: "Grouped" });

      const html = await expectHtmlResponse(
        await get("/listings?filter=standard"),
        200,
        "Standard One",
      );
      expect(html).not.toContain("Daily One");
      expect(html).not.toContain("Group One");
      // Active filter is bold + underlined; others remain links.
      expect(html).toContain("<strong><u>Standard</u></strong>");
      expect(html).toContain('href="/listings?filter=daily"');
    });

    test("filters to daily listings", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Daily One", ...DAILY });
      const html = await expectHtmlResponse(
        await get("/listings?filter=daily"),
        200,
        "Daily One",
      );
      expect(html).not.toContain("Standard One");
      expect(html).toContain("<strong><u>Daily</u></strong>");
    });

    test("filters to purchase-only listings", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Merch", purchaseOnly: true });
      const html = await expectHtmlResponse(
        await get("/listings?filter=purchase-only"),
        200,
        "Merch",
      );
      expect(html).not.toContain("Standard One");
      expect(html).toContain("Purchase Only");
    });

    test("shows all listings and groups on the unfiltered view", async () => {
      await createTestListing({ name: "Standard One" });
      const group = await createTestGroup({ name: "Group One", slug: "grp" });
      await createTestListing({ groupId: group.id, name: "Grouped" });

      const html = await expectHtmlResponse(
        await get("/listings"),
        200,
        "Standard One",
        "Group One",
      );
      // Only one listing type present → no filter bar.
      expect(html).not.toContain("Showing:");
    });

    test("treats an unknown filter value as 'all'", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Daily One", ...DAILY });
      const html = await expectHtmlResponse(
        await get("/listings?filter=bogus"),
        200,
        "Standard One",
        "Daily One",
      );
      expect(html).toContain("<strong><u>All</u></strong>");
    });
  });
});
