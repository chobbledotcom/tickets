import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ensureBuiltSiteSchedulerKey } from "#db/built-site-scheduler.ts";
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import {
  builtSitesCrudTable,
  getAssignableBuiltSites,
  insertBuiltSite,
  updateBuiltSite,
} from "#db/built-sites.ts";
import { getDb } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  beforeNextTransaction,
  wrapDbClient,
} from "#test-utils/record-queries.ts";

/** The paid term a claim stamps, as the assignment computes it. */
const STAMPED_CUTOFF = "2099-01-01T00:00:00.000Z";

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

    const take = await takePooledSiteForBuyer(pool, 42, [7], 7, STAMPED_CUTOFF);

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

    const firstTake = await takePooledSiteForBuyer(
      pool,
      42,
      [7],
      7,
      STAMPED_CUTOFF,
    );
    const secondTake = await takePooledSiteForBuyer(
      pool,
      43,
      [7],
      7,
      STAMPED_CUTOFF,
    );

    expect(firstTake.kind === "claimed" && firstTake.site.name).toBe("Second");
    expect(secondTake.kind === "claimed" && secondTake.site.name).toBe("First");
  });

  test("reads a served buyer back on a second take", async () => {
    await insertBuiltSite("Serving", "serving.b-cdn.net", "", "", true);
    const pool = await getAssignableBuiltSites();

    await takePooledSiteForBuyer(pool, 42, [7], 7, STAMPED_CUTOFF);
    const second = await takePooledSiteForBuyer(
      pool,
      42,
      [7],
      7,
      STAMPED_CUTOFF,
    );

    expect(second.kind).toBe("served");
    // The take hands back the site the buyer's earlier claim gave them, so
    // the caller can re-send its setup link without a second claim.
    expect(second.kind === "served" && second.site.siteUrl).toBe(
      "serving.b-cdn.net",
    );
  });

  test("reports an empty pool when every candidate is already taken", async () => {
    await insertBuiltSite("Already Taken", "taken.b-cdn.net", "", "", true);
    const pool = await getAssignableBuiltSites();

    await takePooledSiteForBuyer(pool, 42, [7], 7, STAMPED_CUTOFF);
    // An unchanged copy of the pool, so the second take still offers the
    // now-taken site and exercises the conditional UPDATE's guard.
    const secondBuyer = await takePooledSiteForBuyer(
      [...pool],
      43,
      [7],
      7,
      STAMPED_CUTOFF,
    );

    expect(secondBuyer).toEqual({ kind: "empty" });
  });

  test("reports an empty pool for a buyer with no candidates", async () => {
    const take = await takePooledSiteForBuyer([], 42, [7], 7, STAMPED_CUTOFF);
    expect(take).toEqual({ kind: "empty" });
  });

  test("hands back the claimed row as it stands after the claim", async () => {
    const site = await insertBuiltSite(
      "Fresh Read",
      "stale.test",
      "",
      "",
      true,
    );
    const pool = await getAssignableBuiltSites();
    // A whole-row write lands between the pool load and the claim: the take
    // must hand back the fresh row, not the pool snapshot. The write runs
    // just before the claim's transaction opens.
    const restore = beforeNextTransaction(async () => {
      await updateBuiltSite(site.id, () => ({
        siteUrl: "https://fresh.example.test",
      }));
    });
    try {
      const take = await takePooledSiteForBuyer(
        pool,
        42,
        [7],
        7,
        STAMPED_CUTOFF,
      );
      expect(take.kind).toBe("claimed");
      expect(take.kind === "claimed" && take.site.siteUrl).toBe(
        "https://fresh.example.test",
      );
    } finally {
      restore();
    }
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
    const real = getDb();

    // Force the interleaving: the scheduler has read the row by the time
    // its revision-fenced write lands, so the write gate starts the claim
    // and holds the stale write until the claim has committed — the write
    // must retry over the assignment instead of reverting it.
    let startClaim: () => void = () => {};
    const claimStarted = new Promise<void>((resolve) => {
      startClaim = resolve;
    });
    const claim = (async () => {
      await claimStarted;
      return takePooledSiteForBuyer(pool, 42, [7], 7, STAMPED_CUTOFF);
    })();
    const restore = wrapDbClient({
      batch: () => {},
      execute: (statement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (typeof sql === "string" && sql.includes("site_data_revision = ?")) {
          startClaim();
          return (async () => {
            await claim;
            return real.execute(statement);
          })();
        }
        return null;
      },
    });
    try {
      const key = await ensureBuiltSiteSchedulerKey(site.id);
      await claim;

      expect(await builtSitesCrudTable.read.one({ id: site.id })).toMatchObject(
        {
          assignable: false,
          assignedAttendeeId: 42,
          assignedListingId: 7,
          scheduledTaskKey: key,
          siteDataRevision: 2,
        },
      );
    } finally {
      restore();
    }
  });
});
