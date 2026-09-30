import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  builtSites,
  insertBuiltSite,
  updateBuiltSiteIfUnchanged,
} from "#db/built-sites.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("updateBuiltSiteIfUnchanged", { db: true }, () => {
  test("applies the change while the revision still matches", async () => {
    await insertBuiltSite("Fresh Revision", "fresh.test", "", "", false);
    const site = (await builtSites.getAll())[0]!;

    const applied = await updateBuiltSiteIfUnchanged(
      site.id,
      site.siteDataRevision,
      {
        readOnlyFrom: "2030-01-01T00:00:00.000Z",
      },
    );

    expect(applied).toBe(true);
    expect((await builtSites.getAll())[0]!.readOnlyFrom).toBe(
      "2030-01-01T00:00:00.000Z",
    );
  });

  test("refuses the change once a concurrent write moved the revision", async () => {
    await insertBuiltSite("Moved Revision", "moved.test", "", "", false);
    const site = (await builtSites.getAll())[0]!;
    // Simulate the concurrent write: bump the revision past the caller's read.
    const stale = site.siteDataRevision - 1;

    const applied = await updateBuiltSiteIfUnchanged(site.id, stale, {
      readOnlyFrom: "2031-01-01T00:00:00.000Z",
    });

    expect(applied).toBe(false);
    expect((await builtSites.getAll())[0]!.readOnlyFrom).toBe("");
  });
});
