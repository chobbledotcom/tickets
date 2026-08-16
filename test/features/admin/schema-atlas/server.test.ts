import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { cachedAdminPage, testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("server (admin schema map)", { db: true }, () => {
  const page = cachedAdminPage("/admin/schema");

  describe("GET /admin/schema", () => {
    testRequiresAuth("/admin/schema");

    test("renders every machine section with its diagram data", async () => {
      await page(
        "<h1>System map</h1>",
        'data-schema-atlas-machine="refund"',
        'data-schema-atlas-machine="review"',
        'id="schema-atlas-data"',
      );
    });

    test("answers the map question in the static list", async () => {
      const html = await page("Your decision needed: some money is back");
      // The one-exit owner decision shows exactly its own way forward.
      expect(html).toContain("You confirm the money came back → Money back");
      // The page names no real payment anywhere.
      expect(html).not.toMatch(/\/admin\/privacy\/refunds\/\d+/);
    });
  });
});
