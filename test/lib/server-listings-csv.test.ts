import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminGet,
  createTestListing,
  describeWithEnv,
  testRequiresAuth,
} from "#test-utils";

const DAILY = {
  bookableDays: ["Monday"],
  listingType: "daily" as const,
  maximumDaysAfter: 14,
  minimumDaysBefore: 0,
};

describeWithEnv("server (admin listings CSV)", { db: true }, () => {
  describe("GET /admin/listings/csv", () => {
    testRequiresAuth("/admin/listings/csv");

    test("exports every listing as a CSV download", async () => {
      await createTestListing({ name: "Gala Night" });
      const response = await adminGet("/admin/listings/csv");
      expect(response.headers.get("content-type")).toContain("text/csv");
      expect(response.headers.get("content-disposition")).toContain(
        'filename="listings.csv"',
      );
      const csv = await response.text();
      expect(csv.split("\n")[0]).toContain("Name,Status,Type");
      expect(csv).toContain("Gala Night");
    });

    test("filters the export to one type and names the file by type", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Daily One", ...DAILY });
      const response = await adminGet("/admin/listings/csv?type=daily");
      expect(response.headers.get("content-disposition")).toContain(
        'filename="listings_daily.csv"',
      );
      const csv = await response.text();
      expect(csv).toContain("Daily One");
      expect(csv).not.toContain("Standard One");
    });
  });
});
