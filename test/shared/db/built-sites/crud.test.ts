import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import {
  builtSites,
  createBuiltSite,
  findBuiltSiteById,
  getAssignableBuiltSites,
  insertBuiltSite,
  requireBuiltSiteByIdPrimary,
  updateBuiltSite,
  updateBuiltSiteRenewalState,
} from "#db/built-sites.ts";
import { mustReadFromPrimary } from "#db/primary-reads.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { wrapDbClient } from "#test-utils/record-queries.ts";
import { builtSiteFormInput, storedSiteRow } from "./fixtures.ts";

describeWithEnv("built-site records", { db: true }, () => {
  test("reads back every built site", async () => {
    await insertBuiltSite("Site A", "a.bunny.run");
    await insertBuiltSite("Site B", "b.bunny.run");
    expect((await builtSites.getAll()).map((site) => site.name)).toEqual([
      "Site A",
      "Site B",
    ]);
  });

  test("finds a site by id, and finds nothing for an id with no site", async () => {
    const site = await createBuiltSite(builtSiteFormInput());

    expect(await findBuiltSiteById(site.id)).toMatchObject({
      id: site.id,
      name: "Original",
    });
    expect(await findBuiltSiteById(site.id + 1)).toBeNull();
  });

  test("stores the site data from the input in the blob", async () => {
    const { blob } = await storedSiteRow({
      assignable: false,
      dbToken: "tok123",
      dbUrl: "libsql://test.turso.io",
      hostingId: "777",
      name: "Test",
      siteUrl: "test.bunny.run",
    });
    expect(blob).toMatchObject({
      d: "libsql://test.turso.io",
      n: "Test",
      s: "777",
      t: "tok123",
      u: "test.bunny.run",
    });
  });

  test("stores the empty value of each field that the input leaves out", async () => {
    const row = await storedSiteRow({});
    expect(row.assignable).toBe(0);
    expect(row.blob).toMatchObject({ n: "", u: "" });
  });

  test("a site stored from no fields reads back with every default", async () => {
    expect(await createBuiltSite({})).toMatchObject({
      assignable: false,
      assignedAttendeeId: null,
      assignedListingId: null,
      // A site that predates the two-step rotation has none waiting.
      databaseKeyRotationStarted: 0,
      dbProvider: "bunny",
      dbToken: "",
      dbUrl: "",
      hostingId: "",
      hostingProvider: "bunny",
      name: "",
      readOnlyFrom: "",
      renewalToken: null,
      renewalTokenIndex: null,
      scheduledTaskKey: null,
      siteDataRevision: 0,
      siteUrl: "",
      updates: "release",
    });
  });

  test("stores true assignable as one", async () => {
    const row = await storedSiteRow(builtSiteFormInput({ assignable: true }));
    expect(row.assignable).toBe(1);
  });

  test("update preserves the existing name", async () => {
    const site = await createBuiltSite(builtSiteFormInput());
    const updated = await updateBuiltSite(site.id, () => ({
      siteUrl: "new.bunny.run",
    }));
    expect(updated?.name).toBe("Original");
    expect(updated?.siteUrl).toBe("new.bunny.run");
  });

  test("update preserves the existing site URL", async () => {
    const site = await createBuiltSite(builtSiteFormInput());
    const updated = await updateBuiltSite(site.id, () => ({
      name: "Updated",
    }));
    expect(updated?.name).toBe("Updated");
    expect(updated?.siteUrl).toBe("original.bunny.run");
  });

  test("update preserves credentials not included in the edit", async () => {
    const site = await createBuiltSite(
      builtSiteFormInput({
        dbToken: "tok123",
        dbUrl: "libsql://db.turso.io",
        hostingId: "98765",
      }),
    );
    const updated = await updateBuiltSite(site.id, () => ({
      name: "Updated",
    }));
    expect(updated).toMatchObject({
      dbToken: "tok123",
      dbUrl: "libsql://db.turso.io",
      hostingId: "98765",
    });
  });

  test("update changes hosting id when provided", async () => {
    const site = await createBuiltSite(
      builtSiteFormInput({ hostingId: "111" }),
    );
    expect(
      await updateBuiltSite(site.id, () => ({ hostingId: "222" })),
    ).toMatchObject({ hostingId: "222" });
  });

  test("update returns null for a missing id", async () => {
    expect(await updateBuiltSite(999, () => ({ name: "Test" }))).toBeNull();
  });

  test("reads from the primary before updating a newly written site", async () => {
    const site = await createBuiltSite(builtSiteFormInput());
    const primaryReads: boolean[] = [];
    const restore = wrapDbClient({
      batch: (statements, mode) => {
        if (
          statements.some((statement) =>
            statement.sql.includes("FROM built_sites"),
          )
        ) {
          primaryReads.push(mode === "write");
        }
      },
      execute: (statement) => {
        if (statement.sql.includes("FROM built_sites")) {
          primaryReads.push(mustReadFromPrimary());
        }
        return null;
      },
    });
    try {
      await updateBuiltSite(site.id, () => ({ assignable: true }));
    } finally {
      restore();
    }

    expect(primaryReads).toEqual([true]);
  });

  test("update preserves stored state and advances its revision", async () => {
    const row = await insertBuiltSite(
      "Stateful",
      "stateful.example.test",
      "",
      "",
      true,
    );
    const pool = await getAssignableBuiltSites();
    await takePooledSiteForBuyer(pool, 42, [7], 7);
    await updateBuiltSiteRenewalState(row.id, {
      readOnlyFrom: "2027-01-01T00:00:00Z",
      renewalToken: "renewal-token",
      renewalTokenIndex: "renewal-index",
    });
    const updated = await updateBuiltSite(row.id, () => ({
      name: "Edited stateful",
    }));
    expect(updated).toMatchObject({
      assignedAttendeeId: 42,
      assignedListingId: 7,
      readOnlyFrom: "2027-01-01T00:00:00Z",
      renewalTokenIndex: "renewal-index",
      siteDataRevision: 3,
    });
  });

  test("concurrent edits preserve both changes", async () => {
    const site = await createBuiltSite(builtSiteFormInput());
    await Promise.all([
      updateBuiltSite(site.id, () => ({ name: "Renamed" })),
      updateBuiltSite(site.id, () => ({ siteUrl: "moved.bunny.run" })),
    ]);
    expect(await findBuiltSiteById(site.id)).toMatchObject({
      name: "Renamed",
      siteDataRevision: 2,
      siteUrl: "moved.bunny.run",
    });
  });

  test("the required primary read throws for a site id that is gone", async () => {
    await expect(requireBuiltSiteByIdPrimary(987654)).rejects.toThrow(
      "Built site 987654 not found",
    );
  });
});
