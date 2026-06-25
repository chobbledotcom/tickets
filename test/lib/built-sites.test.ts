import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  assignBuiltSite,
  builtSitesCrudTable,
  claimNextBuiltSiteForPrune,
  getAllBuiltSites,
  getAssignableBuiltSites,
  getBuiltSiteByRenewalTokenIndex,
  insertBuiltSite,
  parseSiteDataBlob,
  siteBaseUrl,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { describeWithEnv } from "#test-utils";

const formBlob = async (
  input: Parameters<typeof builtSitesCrudTable.toDbValues>[0],
) => {
  const values = await builtSitesCrudTable.toDbValues(input);
  return parseSiteDataBlob(values.site_data as string);
};

describe("siteBaseUrl", () => {
  test("prepends https:// to a bare hostname", () => {
    expect(siteBaseUrl("site.b-cdn.net")).toBe("https://site.b-cdn.net");
  });

  test("keeps an existing scheme", () => {
    expect(siteBaseUrl("http://example.com")).toBe("http://example.com");
  });

  test("strips a trailing slash so a path can be appended", () => {
    expect(siteBaseUrl("https://example.com/")).toBe("https://example.com");
  });

  test("collapses a path, query, and hash to the origin", () => {
    expect(siteBaseUrl("https://example.com/admin?x=1#y")).toBe(
      "https://example.com",
    );
  });

  test("normalizes an uppercase scheme to a lowercase origin", () => {
    expect(siteBaseUrl("HTTPS://example.com")).toBe("https://example.com");
  });
});

describeWithEnv("claimNextBuiltSiteForPrune", { db: true }, () => {
  test("returns null when there are no built sites", async () => {
    expect(await claimNextBuiltSiteForPrune()).toBe(null);
  });

  test("walks sites least-recently-pruned first, then round-robins", async () => {
    await insertBuiltSite("A", "a.example.com");
    await insertBuiltSite("B", "b.example.com");

    // Both start never-pruned (''), so the lowest id goes first; after each is
    // stamped, the other (still '') is next; then it cycles back to the oldest.
    const first = await claimNextBuiltSiteForPrune();
    const second = await claimNextBuiltSiteForPrune();
    const third = await claimNextBuiltSiteForPrune();

    expect(first?.bunnyUrl).toBe("a.example.com");
    expect(second?.bunnyUrl).toBe("b.example.com");
    expect(third?.bunnyUrl).toBe("a.example.com");
  });
});

describeWithEnv("built-sites", { db: true }, () => {
  test("toDbValues creates valid site-data JSON", async () => {
    const parsed = await formBlob({
      bunnyUrl: "test.b-cdn.net",
      name: "Test Site",
    });
    expect(parsed.n).toBe("Test Site");
    expect(parsed.u).toBe("test.b-cdn.net");
    expect(parsed.v).toBe(1);
  });

  test("toDbValues includes db credentials when provided", async () => {
    const parsed = await formBlob({
      bunnyUrl: "test.b-cdn.net",
      dbToken: "secret-token",
      dbUrl: "libsql://db.turso.io",
      name: "Test Site",
    });
    expect(parsed.d).toBe("libsql://db.turso.io");
    expect(parsed.t).toBe("secret-token");
  });

  test("toDbValues omits db keys when empty", async () => {
    const parsed = await formBlob({
      bunnyUrl: "test.b-cdn.net",
      name: "Test Site",
    });
    expect(parsed.d).toBeUndefined();
    expect(parsed.t).toBeUndefined();
  });

  test("toDbValues includes bunny script id when provided", async () => {
    const parsed = await formBlob({
      bunnyScriptId: "98765",
      bunnyUrl: "test.b-cdn.net",
      name: "Test Site",
    });
    expect(parsed.s).toBe("98765");
  });

  test("toDbValues omits bunny script id when empty", async () => {
    const parsed = await formBlob({
      bunnyUrl: "test.b-cdn.net",
      name: "Test Site",
    });
    expect(parsed.s).toBeUndefined();
  });

  test("parseSiteDataBlob decodes stored site-data JSON", async () => {
    const parsed = await formBlob({
      bunnyUrl: "my.b-cdn.net",
      name: "My Site",
    });
    expect(parsed.n).toBe("My Site");
    expect(parsed.u).toBe("my.b-cdn.net");
    expect(parsed.v).toBe(1);
  });

  test("parseSiteDataBlob handles legacy blobs without db keys", () => {
    const legacyBlob = JSON.stringify({
      n: "Old Site",
      u: "old.b-cdn.net",
      v: 1,
    });
    const parsed = parseSiteDataBlob(legacyBlob);
    expect(parsed.d).toBeUndefined();
    expect(parsed.t).toBeUndefined();
    expect(parsed.s).toBeUndefined();
  });

  test("insertBuiltSite creates a row with encrypted site_data", async () => {
    const row = await insertBuiltSite("Alpha Site", "alpha.b-cdn.net");
    expect(row.id).toBe(1);
    expect(row.created).toBeTruthy();
  });

  test("insertBuiltSite stores db credentials when provided", async () => {
    await insertBuiltSite(
      "DB Site",
      "db.b-cdn.net",
      "libsql://db.turso.io",
      "secret-token",
    );
    const sites = await getAllBuiltSites();
    const site = sites.find((s) => s.name === "DB Site")!;
    expect(site.dbUrl).toBe("libsql://db.turso.io");
    expect(site.dbToken).toBe("secret-token");
  });

  test("insertBuiltSite defaults db credentials to empty strings", async () => {
    await insertBuiltSite("No DB Site", "nodb.b-cdn.net");
    const sites = await getAllBuiltSites();
    const site = sites.find((s) => s.name === "No DB Site")!;
    expect(site.dbUrl).toBe("");
    expect(site.dbToken).toBe("");
  });

  test("insertBuiltSite stores bunny script id when provided", async () => {
    await insertBuiltSite(
      "Script Site",
      "script.b-cdn.net",
      "",
      "",
      false,
      "12345",
    );
    const sites = await getAllBuiltSites();
    const site = sites.find((s) => s.name === "Script Site")!;
    expect(site.bunnyScriptId).toBe("12345");
  });

  test("insertBuiltSite defaults bunny script id to empty string", async () => {
    await insertBuiltSite("No Script Site", "noscript.b-cdn.net");
    const sites = await getAllBuiltSites();
    const site = sites.find((s) => s.name === "No Script Site")!;
    expect(site.bunnyScriptId).toBe("");
  });

  test("getAllBuiltSites returns decrypted sites sorted by name", async () => {
    await insertBuiltSite("Charlie", "charlie.b-cdn.net");
    await insertBuiltSite("Alpha", "alpha.b-cdn.net");
    await insertBuiltSite("Bravo", "bravo.b-cdn.net");

    const sites = await getAllBuiltSites();
    expect(sites).toHaveLength(3);
    expect(sites[0]!.name).toBe("Alpha");
    expect(sites[0]!.bunnyUrl).toBe("alpha.b-cdn.net");
    expect(sites[1]!.name).toBe("Bravo");
    expect(sites[2]!.name).toBe("Charlie");
  });

  test("getAllBuiltSites returns empty array when no sites exist", async () => {
    const sites = await getAllBuiltSites();
    expect(sites).toHaveLength(0);
  });

  describe("builtSitesCrudTable", () => {
    test("findAll returns all built sites", async () => {
      await insertBuiltSite("Site A", "a.bunny.run");
      await insertBuiltSite("Site B", "b.bunny.run");

      const sites = await builtSitesCrudTable.findAll();
      expect(sites).toHaveLength(2);
    });

    test("fromDb returns the row unchanged", async () => {
      const site = {
        assignable: false,
        assignedAttendeeId: null,
        assignedListingId: null,
        bunnyScriptId: "",
        bunnyUrl: "test.bunny.run",
        created: "2026-01-01",
        dbToken: "",
        dbUrl: "",
        id: 1,
        name: "Test",
        readOnlyFrom: "",
        renewalToken: null,
        renewalTokenIndex: null,
      };
      const result = await builtSitesCrudTable.fromDb(site);
      expect(result).toEqual(site);
    });

    test("inputKeyMap exposes form-facing fields", () => {
      expect(builtSitesCrudTable.inputKeyMap).toEqual({
        assignable: "assignable",
        bunny_script_id: "bunnyScriptId",
        bunny_url: "bunnyUrl",
        db_token: "dbToken",
        db_url: "dbUrl",
        name: "name",
      });
    });

    test("rowToInput exposes form-input fields for reuse", () => {
      const site = {
        assignable: true,
        assignedAttendeeId: null,
        assignedListingId: null,
        bunnyScriptId: "script-123",
        bunnyUrl: "example.bunny.run",
        created: "2026-01-01",
        dbToken: "token",
        dbUrl: "libsql://db",
        id: 42,
        name: "Mirror",
        readOnlyFrom: "",
        renewalToken: null,
        renewalTokenIndex: null,
      };
      expect(builtSitesCrudTable.rowToInput(site)).toEqual({
        assignable: true,
        bunnyScriptId: "script-123",
        bunnyUrl: "example.bunny.run",
        dbToken: "token",
        dbUrl: "libsql://db",
        name: "Mirror",
      });
    });

    test("toDbValues builds encrypted blob from input", async () => {
      const values = await builtSitesCrudTable.toDbValues({
        assignable: false,
        bunnyScriptId: "777",
        bunnyUrl: "test.bunny.run",
        dbToken: "tok123",
        dbUrl: "libsql://test.turso.io",
        name: "Test",
      });
      expect(values.site_data).toBeTruthy();
      const parsed = parseSiteDataBlob(values.site_data as string);
      expect(parsed.n).toBe("Test");
      expect(parsed.u).toBe("test.bunny.run");
      expect(parsed.d).toBe("libsql://test.turso.io");
      expect(parsed.t).toBe("tok123");
      expect(parsed.s).toBe("777");
    });

    test("update preserves existing name when only bunnyUrl provided", async () => {
      const site = await builtSitesCrudTable.insert({
        assignable: false,
        bunnyScriptId: "",
        bunnyUrl: "original.bunny.run",
        dbToken: "",
        dbUrl: "",
        name: "Original",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        bunnyUrl: "new.bunny.run",
      });
      expect(updated!.name).toBe("Original");
      expect(updated!.bunnyUrl).toBe("new.bunny.run");
    });

    test("update preserves existing bunnyUrl when only name provided", async () => {
      const site = await builtSitesCrudTable.insert({
        assignable: false,
        bunnyScriptId: "",
        bunnyUrl: "original.bunny.run",
        dbToken: "",
        dbUrl: "",
        name: "Original",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Updated",
      });
      expect(updated!.name).toBe("Updated");
      expect(updated!.bunnyUrl).toBe("original.bunny.run");
    });

    test("update preserves existing db credentials when not provided", async () => {
      const site = await builtSitesCrudTable.insert({
        assignable: false,
        bunnyScriptId: "",
        bunnyUrl: "original.bunny.run",
        dbToken: "tok123",
        dbUrl: "libsql://db.turso.io",
        name: "Original",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Updated",
      });
      expect(updated!.dbUrl).toBe("libsql://db.turso.io");
      expect(updated!.dbToken).toBe("tok123");
    });

    test("update preserves existing bunny script id when not provided", async () => {
      const site = await builtSitesCrudTable.insert({
        assignable: false,
        bunnyScriptId: "98765",
        bunnyUrl: "original.bunny.run",
        dbToken: "",
        dbUrl: "",
        name: "Original",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Updated",
      });
      expect(updated!.bunnyScriptId).toBe("98765");
    });

    test("update changes bunny script id when provided", async () => {
      const site = await builtSitesCrudTable.insert({
        assignable: false,
        bunnyScriptId: "111",
        bunnyUrl: "original.bunny.run",
        dbToken: "",
        dbUrl: "",
        name: "Original",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        bunnyScriptId: "222",
      });
      expect(updated!.bunnyScriptId).toBe("222");
    });

    test("update returns null for non-existent id", async () => {
      const result = await builtSitesCrudTable.update(999, {
        name: "Test",
      });
      expect(result).toBeNull();
    });

    test("toDbValues handles partial input with missing fields", async () => {
      const values = await builtSitesCrudTable.toDbValues({});
      const parsed = parseSiteDataBlob(values.site_data as string);
      expect(parsed.n).toBe("");
      expect(parsed.u).toBe("");
    });

    test("toDbValues sets assignable to 1 when true", async () => {
      const values = await builtSitesCrudTable.toDbValues({
        assignable: true,
        bunnyScriptId: "",
        bunnyUrl: "test.bunny.run",
        dbToken: "",
        dbUrl: "",
        name: "Test",
      });
      expect(values.assignable).toBe(1);
    });
  });

  describe("assignable sites", () => {
    test("insertBuiltSite with assignable flag", async () => {
      await insertBuiltSite("Assignable Site", "a.b-cdn.net", "", "", true);
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Assignable Site")!;
      expect(site.assignable).toBe(true);
    });

    test("insertBuiltSite defaults to not assignable", async () => {
      await insertBuiltSite("Default Site", "d.b-cdn.net");
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Default Site")!;
      expect(site.assignable).toBe(false);
    });

    test("getAssignableBuiltSites filters to assignable only", async () => {
      await insertBuiltSite("Site A", "a.b-cdn.net", "", "", true);
      await insertBuiltSite("Site B", "b.b-cdn.net", "", "", false);
      await insertBuiltSite("Site C", "c.b-cdn.net", "", "", true);
      const sites = await getAssignableBuiltSites();
      expect(sites).toHaveLength(2);
      expect(sites.every((s) => s.assignable)).toBe(true);
    });

    test("assignBuiltSite marks site as not assignable and stores IDs in columns", async () => {
      await insertBuiltSite("To Assign", "assign.b-cdn.net", "", "", true);
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "To Assign")!;

      const updated = await assignBuiltSite(site.id, 42, 7);
      expect(updated).not.toBeNull();
      expect(updated!.assignable).toBe(false);
      expect(updated!.assignedAttendeeId).toBe(42);
      expect(updated!.assignedListingId).toBe(7);
    });

    test("assignBuiltSite returns null for non-existent site", async () => {
      const result = await assignBuiltSite(999, 1, 1);
      expect(result).toBeNull();
    });

    test("unassigned sites have null attendee and listing IDs", async () => {
      await insertBuiltSite("Unassigned", "u.b-cdn.net", "", "", true);
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Unassigned")!;
      expect(site.assignedAttendeeId).toBeNull();
      expect(site.assignedListingId).toBeNull();
    });
  });

  describe("renewal columns", () => {
    test("new sites have empty readOnlyFrom and null renewal fields", async () => {
      await insertBuiltSite("Renewal Site", "renewal.b-cdn.net");
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Renewal Site")!;
      expect(site.readOnlyFrom).toBe("");
      expect(site.renewalTokenIndex).toBeNull();
    });

    test("getBuiltSiteByRenewalTokenIndex returns matching site", async () => {
      await insertBuiltSite("Token Site", "token.b-cdn.net");
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Token Site")!;

      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2026-07-01T00:00:00Z",
        renewalToken: "raw-token-123",
        renewalTokenIndex: "test-index-abc",
      });

      const found = await getBuiltSiteByRenewalTokenIndex("test-index-abc");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Token Site");
      expect(found!.readOnlyFrom).toBe("2026-07-01T00:00:00Z");
    });

    test("getBuiltSiteByRenewalTokenIndex returns null when no match", async () => {
      const found = await getBuiltSiteByRenewalTokenIndex("nonexistent");
      expect(found).toBeNull();
    });

    test("multiple sites with null renewalTokenIndex are allowed", async () => {
      await insertBuiltSite("Site 1", "s1.b-cdn.net");
      await insertBuiltSite("Site 2", "s2.b-cdn.net");
      const sites = await getAllBuiltSites();
      const nullIndexSiteNames = sites
        .filter((s) => s.renewalTokenIndex === null)
        .map((s) => s.name)
        .sort();
      expect(nullIndexSiteNames).toEqual(["Site 1", "Site 2"]);
    });

    test("legacy blob still decodes correctly (no rt field)", () => {
      const legacyBlob = JSON.stringify({
        n: "Old Site",
        u: "old.b-cdn.net",
        v: 1,
      });
      const parsed = parseSiteDataBlob(legacyBlob);
      expect(parsed.rt).toBeUndefined();
      expect(parsed.n).toBe("Old Site");
    });

    test("CRUD update preserves existing renewal token", async () => {
      const site = await builtSitesCrudTable.insert({
        assignable: false,
        bunnyScriptId: "100",
        bunnyUrl: "preserve.b-cdn.net",
        dbToken: "",
        dbUrl: "",
        name: "Token Preserve",
      });

      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2026-08-01T00:00:00Z",
        renewalToken: "secret-token",
        renewalTokenIndex: "idx-123",
      });

      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Token Preserve Updated",
      });

      expect(updated!.name).toBe("Token Preserve Updated");
      expect(updated!.renewalTokenIndex).toBe("idx-123");
      expect(updated!.readOnlyFrom).toBe("2026-08-01T00:00:00Z");
      expect(updated!.renewalToken).toBe("secret-token");
    });

    test("updateBuiltSiteRenewalState updates individual fields", async () => {
      await insertBuiltSite("Renewal Update", "ru.b-cdn.net");
      const sites = await getAllBuiltSites();
      const site = sites.find((s) => s.name === "Renewal Update")!;

      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2027-01-01T00:00:00Z",
      });
      const afterFirst = await getAllBuiltSites();
      const updatedAfterFirst = afterFirst.find((s) => s.id === site.id)!;
      expect(updatedAfterFirst.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
      expect(updatedAfterFirst.renewalTokenIndex).toBeNull();

      await updateBuiltSiteRenewalState(site.id, {
        renewalToken: "tok-456",
        renewalTokenIndex: "idx-456",
      });
      const afterSecond = await getBuiltSiteByRenewalTokenIndex("idx-456");
      expect(afterSecond).not.toBeNull();
      expect(afterSecond!.renewalTokenIndex).toBe("idx-456");
      expect(afterSecond!.renewalToken).toBe("tok-456");
      expect(afterSecond!.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
    });
  });
});
