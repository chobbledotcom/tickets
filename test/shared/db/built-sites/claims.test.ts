import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ensureBuiltSiteSchedulerKey } from "#db/built-site-scheduler.ts";
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import {
  builtSitesCrudTable,
  getAssignableBuiltSites,
  insertBuiltSite,
} from "#db/built-sites.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("taking a pooled site for a buyer", { db: true }, () => {
  test("stores the assignment and hands back the claimed site", async () => {
    const row = await insertBuiltSite(
      "To Assign",
      "assign.b-cdn.net",
      "",
      "",
      true,
    );
    const pool = await getAssignableBuiltSites();

    const take = await takePooledSiteForBuyer(pool, 42, [7], 7);

    expect(take.kind).toBe("claimed");
    expect(take.kind === "claimed" && take.site.id).toBe(row.id);
    expect(pool).toHaveLength(0);
    expect(await builtSitesCrudTable.read.one({ id: row.id })).toMatchObject({
      assignable: false,
      assignedAttendeeId: 42,
      assignedListingId: 7,
    });
  });

  test("claims the last pool entry first, then the next", async () => {
    await insertBuiltSite("First", "first.b-cdn.net", "", "", true);
    await insertBuiltSite("Second", "second.b-cdn.net", "", "", true);
    // Sorted by id, so the pool order does not depend on the read order.
    const pool = (await getAssignableBuiltSites()).sort((a, b) => a.id - b.id);

    const firstTake = await takePooledSiteForBuyer(pool, 42, [7], 7);
    const secondTake = await takePooledSiteForBuyer(pool, 43, [7], 7);

    expect(firstTake.kind === "claimed" && firstTake.site.name).toBe("Second");
    expect(secondTake.kind === "claimed" && secondTake.site.name).toBe("First");
  });

  test("reads a served buyer back on a second take", async () => {
    await insertBuiltSite("Serving", "serving.b-cdn.net", "", "", true);
    const pool = await getAssignableBuiltSites();

    await takePooledSiteForBuyer(pool, 42, [7], 7);
    const second = await takePooledSiteForBuyer(pool, 42, [7], 7);

    expect(second).toEqual({ kind: "served" });
  });

  test("reports an empty pool when every candidate is already taken", async () => {
    await insertBuiltSite("Already Taken", "taken.b-cdn.net", "", "", true);
    const pool = await getAssignableBuiltSites();

    await takePooledSiteForBuyer(pool, 42, [7], 7);
    const secondBuyer = await takePooledSiteForBuyer(pool, 43, [7], 7);

    expect(secondBuyer).toEqual({ kind: "empty" });
  });

  test("reports an empty pool for a buyer with no candidates", async () => {
    const take = await takePooledSiteForBuyer([], 42, [7], 7);
    expect(take).toEqual({ kind: "empty" });
  });

  test("keeps an assignment made during scheduler-key provisioning", async () => {
    const site = await insertBuiltSite(
      "Concurrent assignment",
      "concurrent.example.test",
      "",
      "",
      true,
    );
    const pool = await getAssignableBuiltSites();

    await Promise.all([
      ensureBuiltSiteSchedulerKey(site.id),
      takePooledSiteForBuyer(pool, 42, [7], 7),
    ]);

    expect(await builtSitesCrudTable.read.one({ id: site.id })).toMatchObject({
      assignable: false,
      assignedAttendeeId: 42,
      assignedListingId: 7,
      siteDataRevision: 2,
    });
  });
});
