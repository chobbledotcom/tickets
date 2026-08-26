import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { parseSiteDataBlob } from "#db/built-sites/blob.ts";
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  assignBuiltSite,
  builtSitesCrudTable,
  insertBuiltSite,
  updateBuiltSiteRenewalState,
} from "#db/built-sites.ts";
import { mustReadFromPrimary } from "#db/primary-reads.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { statementSql, wrapDbClient } from "#test-utils/record-queries.ts";
import { builtSiteFormInput } from "./fixtures.ts";

const siteFixture = (overrides: Partial<BuiltSite> = {}): BuiltSite => ({
  assignable: false,
  assignedAttendeeId: null,
  assignedListingId: null,
  created: "2026-01-01",
  dbProvider: "bunny",
  dbToken: "",
  dbUrl: "",
  hostingId: "",
  hostingProvider: "bunny",
  id: 1,
  name: "Test",
  readOnlyFrom: "",
  renewalTierListingId: null,
  renewalToken: null,
  renewalTokenIndex: null,
  scheduledTaskKey: null,
  siteDataRevision: 0,
  siteUrl: "test.bunny.run",
  updates: "release",
  ...overrides,
});

describeWithEnv("built-sites CRUD table", { db: true }, () => {
  test("reads back every built site", async () => {
    await insertBuiltSite("Site A", "a.bunny.run");
    await insertBuiltSite("Site B", "b.bunny.run");
    expect(await builtSitesCrudTable.read.many()).toHaveLength(2);
  });

  test("refuses to filter on fields kept inside the blob", () => {
    // A site's name lives in the encrypted blob, not in a column, so no read
    // can find a site by it — saying so is better than reading every site.
    // Every such field is named, so the message is not a guessing game.
    expect(() =>
      builtSitesCrudTable.read.many({ name: "Site A", siteUrl: "a.example" }),
    ).toThrow("Cannot filter built sites by name, siteUrl:");
    // One such field is refused just the same — it must never fall through and
    // quietly read every site.
    expect(() => builtSitesCrudTable.read.many({ name: "Site A" })).toThrow(
      "Cannot filter built sites by name:",
    );
  });

  test("refuses to hand back anything but a whole, opened site", () => {
    // Some of its columns, or a statement whose rows nobody has opened, would
    // both be a site the caller cannot actually read.
    expect(() => builtSitesCrudTable.read.pick(["name"])).toThrow(
      "can only hand back whole, opened sites",
    );
    expect(() => builtSitesCrudTable.read.statement({ id: 1 })).toThrow(
      "can only hand back whole, opened sites",
    );
  });

  test("fromDb returns the row unchanged", async () => {
    const site = siteFixture();
    expect(await builtSitesCrudTable.fromDb(site)).toEqual(site);
  });

  test("readColumn returns the stored value unchanged", async () => {
    expect(await builtSitesCrudTable.readColumn("name", "Test")).toBe("Test");
  });

  test("uses the physical built-sites table name", () => {
    expect(builtSitesCrudTable.name).toBe("built_sites");
  });

  test("inputKeyMap exposes form-facing fields", () => {
    expect(builtSitesCrudTable.inputKeyMap).toEqual({
      assignable: "assignable",
      db_provider: "dbProvider",
      db_token: "dbToken",
      db_url: "dbUrl",
      hosting_id: "hostingId",
      hosting_provider: "hostingProvider",
      name: "name",
      site_url: "siteUrl",
      updates: "updates",
    });
  });

  test("rowToInput exposes form-input fields for reuse", () => {
    const site = siteFixture({
      assignable: true,
      dbToken: "token",
      dbUrl: "libsql://db",
      hostingId: "script-123",
      id: 42,
      name: "Mirror",
      siteUrl: "example.bunny.run",
      updates: "beta",
    });
    expect(builtSitesCrudTable.rowToInput(site)).toEqual({
      assignable: true,
      dbProvider: "bunny",
      dbToken: "token",
      dbUrl: "libsql://db",
      hostingId: "script-123",
      hostingProvider: "bunny",
      name: "Mirror",
      siteUrl: "example.bunny.run",
      updates: "beta",
    });
  });

  test("toDbValues builds site data from input", async () => {
    const values = await builtSitesCrudTable.toDbValues({
      assignable: false,
      dbToken: "tok123",
      dbUrl: "libsql://test.turso.io",
      hostingId: "777",
      name: "Test",
      siteUrl: "test.bunny.run",
    });
    expect(parseSiteDataBlob(values.site_data as string)).toMatchObject({
      d: "libsql://test.turso.io",
      n: "Test",
      s: "777",
      t: "tok123",
      u: "test.bunny.run",
    });
  });

  test("toDbValues supplies every empty-form default", async () => {
    const values = await builtSitesCrudTable.toDbValues({});
    expect(values.assignable).toBe(0);
    expect(parseSiteDataBlob(values.site_data as string)).toMatchObject({
      n: "",
      u: "",
    });
  });

  test("toDbValues stores true assignable as one", async () => {
    const values = await builtSitesCrudTable.toDbValues(
      builtSiteFormInput({ assignable: true }),
    );
    expect(values.assignable).toBe(1);
  });

  test("update preserves the existing name", async () => {
    const site = await builtSitesCrudTable.insert(builtSiteFormInput());
    const updated = await builtSitesCrudTable.update(site.id, {
      siteUrl: "new.bunny.run",
    });
    expect(updated?.name).toBe("Original");
    expect(updated?.siteUrl).toBe("new.bunny.run");
  });

  test("update preserves the existing site URL", async () => {
    const site = await builtSitesCrudTable.insert(builtSiteFormInput());
    const updated = await builtSitesCrudTable.update(site.id, {
      name: "Updated",
    });
    expect(updated?.name).toBe("Updated");
    expect(updated?.siteUrl).toBe("original.bunny.run");
  });

  test("update preserves credentials not included in the edit", async () => {
    const site = await builtSitesCrudTable.insert(
      builtSiteFormInput({
        dbToken: "tok123",
        dbUrl: "libsql://db.turso.io",
        hostingId: "98765",
      }),
    );
    const updated = await builtSitesCrudTable.update(site.id, {
      name: "Updated",
    });
    expect(updated).toMatchObject({
      dbToken: "tok123",
      dbUrl: "libsql://db.turso.io",
      hostingId: "98765",
    });
  });

  test("update changes hosting id when provided", async () => {
    const site = await builtSitesCrudTable.insert(
      builtSiteFormInput({ hostingId: "111" }),
    );
    expect(
      await builtSitesCrudTable.update(site.id, { hostingId: "222" }),
    ).toMatchObject({ hostingId: "222" });
  });

  test("update returns null for a missing id", async () => {
    expect(await builtSitesCrudTable.update(999, { name: "Test" })).toBeNull();
  });

  test("reads from the primary before updating a newly written site", async () => {
    const site = await builtSitesCrudTable.insert(builtSiteFormInput());
    const primaryReads: boolean[] = [];
    const restore = wrapDbClient({
      batch: (statements, mode) => {
        if (
          statements.some((statement) =>
            statementSql(statement).includes("FROM built_sites"),
          )
        ) {
          primaryReads.push(mode === "write");
        }
      },
      execute: (statement) => {
        if (statementSql(statement).includes("FROM built_sites")) {
          primaryReads.push(mustReadFromPrimary());
        }
        return null;
      },
    });
    try {
      await builtSitesCrudTable.update(site.id, { assignable: true });
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
    await assignBuiltSite(row.id, 42, 7);
    await updateBuiltSiteRenewalState(row.id, {
      readOnlyFrom: "2027-01-01T00:00:00Z",
      renewalToken: "renewal-token",
      renewalTokenIndex: "renewal-index",
    });
    const updated = await builtSitesCrudTable.update(row.id, {
      name: "Edited stateful",
    });
    expect(updated).toMatchObject({
      assignedAttendeeId: 42,
      assignedListingId: 7,
      readOnlyFrom: "2027-01-01T00:00:00Z",
      renewalTokenIndex: "renewal-index",
      siteDataRevision: 3,
    });
  });

  test("concurrent edits preserve both changes", async () => {
    const site = await builtSitesCrudTable.insert(builtSiteFormInput());
    await Promise.all([
      builtSitesCrudTable.update(site.id, { name: "Renamed" }),
      builtSitesCrudTable.update(site.id, { siteUrl: "moved.bunny.run" }),
    ]);
    expect(await builtSitesCrudTable.read.one({ id: site.id })).toMatchObject({
      name: "Renamed",
      siteDataRevision: 2,
      siteUrl: "moved.bunny.run",
    });
  });
});
