/** The import of a catalog into a site that has attributes turned off. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runImport } from "#cli/import-run.ts";
import {
  callPaths,
  PRODUCT_FRONTMATTER,
  scriptedApi,
  seedCatalog,
} from "#test/integration/tooling/import-run/helpers.ts";

/** A site with no records, and attributes on or off. Any attribute call
 *  fails the run, because the stub has no attribute route. */
const siteRoutes = (attributes: boolean) => ({
  "GET /api/admin/groups": () => ({ groups: [] }),
  "GET /api/admin/listings": () => ({ features: { attributes }, listings: [] }),
  "POST /api/admin/groups": () => ({
    group: { id: 31, is_package: false, name: "Tarpaulins" },
  }),
  "POST /api/admin/listings": () => ({
    listing: { id: 41, name: "Tumble Tower Hire", slug: "tower-hire" },
  }),
});

const NO_ATTRIBUTES = PRODUCT_FRONTMATTER.replace(
  "filter_attributes:\n  - name: Guest Capacity\n    value: 50 guests\n",
  "",
);

describe("frontmatter import into a site with attributes off", () => {
  test("skips the attribute step, says so, and sends no attribute options", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    const { api, calls } = scriptedApi(siteRoutes(false));

    const report = await runImport({ dir, plan: false, update: false }, api);

    expect(report.lines).toEqual([
      "skipped 1 attributes: the attributes feature is off on the site",
      "created group Tarpaulins",
      "created listing Tumble Tower Hire -> id 41",
    ]);
    expect(report.created).toEqual({
      attributes: 0,
      groups: 1,
      listings: 1,
      options: 0,
    });
    expect(callPaths(calls)).toEqual([
      "GET /api/admin/listings",
      "GET /api/admin/groups",
      "POST /api/admin/groups",
      "POST /api/admin/listings",
    ]);
    expect(Object.keys(calls[3]?.body ?? {})).not.toContain(
      "attribute_option_ids",
    );
  });

  test("says nothing of attributes when the catalog names none", async () => {
    const dir = await seedCatalog(NO_ATTRIBUTES);
    const { api } = scriptedApi(siteRoutes(false));

    const report = await runImport({ dir, plan: false, update: false }, api);

    expect(report.lines).toEqual([
      "created group Tarpaulins",
      "created listing Tumble Tower Hire -> id 41",
    ]);
  });

  test("a plan run skips the attribute step too", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    const { api, calls } = scriptedApi(siteRoutes(false));

    const report = await runImport({ dir, plan: true, update: false }, api);

    expect(report.lines[0]).toBe(
      "skipped 1 attributes: the attributes feature is off on the site",
    );
    expect(callPaths(calls)).toEqual([
      "GET /api/admin/listings",
      "GET /api/admin/groups",
    ]);
  });

  test("refuses a listing answer that does not name the site features", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    const { api } = scriptedApi({
      ...siteRoutes(false),
      "GET /api/admin/listings": () => ({ listings: [] }),
    });

    await expect(
      runImport({ dir, plan: false, update: false }, api),
    ).rejects.toThrow("features");
  });
});
