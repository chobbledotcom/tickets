import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestBuiltSite,
  provisionTestBuiltSite,
} from "#test-utils/db-helpers/built-sites.ts";
import { adminGet } from "#test-utils/session.ts";

/** The built-sites list reads its row order from the address: each offered
 * sort orders the table, and an unknown value falls back to the name order. */
describeWithEnv(
  "server (admin built sites list sort)",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    test("orders by read-only deadline with the address's sort, undated last", async () => {
      const later = await createTestBuiltSite({ name: "Later" });
      const sooner = await createTestBuiltSite({ name: "Sooner" });
      await createTestBuiltSite({ name: "Undated" });
      await provisionTestBuiltSite(later.id, {
        readOnlyFrom: "2099-02-01T00:00:00.000Z",
      });
      await provisionTestBuiltSite(sooner.id, {
        readOnlyFrom: "2099-01-01T00:00:00.000Z",
      });

      const response = await adminGet("/admin/built-sites?sort=read_only_from");
      const body = await response.text();
      expect(body.indexOf("Sooner")).toBeLessThan(body.indexOf("Later"));
      expect(body.indexOf("Later")).toBeLessThan(body.indexOf("Undated"));
    });

    test("falls back to name order for an unknown sort", async () => {
      await createTestBuiltSite({ name: "Zulu" });
      await createTestBuiltSite({ name: "Alpha" });
      const response = await adminGet("/admin/built-sites?sort=nonsense");
      const body = await response.text();
      expect(body.indexOf("Alpha")).toBeLessThan(body.indexOf("Zulu"));
    });
  },
);
