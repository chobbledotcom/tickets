import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildSiteDataBlob,
  builtSitesCrudTable,
  getAllBuiltSites,
  insertBuiltSite,
  parseSiteDataBlob,
} from "#lib/db/built-sites.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("built-sites", { db: true }, () => {
  test("buildSiteDataBlob creates valid JSON with version", () => {
    const blob = buildSiteDataBlob("Test Site", "test.b-cdn.net");
    const parsed = JSON.parse(blob);
    expect(parsed.v).toBe(1);
    expect(parsed.n).toBe("Test Site");
    expect(parsed.u).toBe("test.b-cdn.net");
  });

  test("buildSiteDataBlob includes db credentials when provided", () => {
    const blob = buildSiteDataBlob(
      "Test Site",
      "test.b-cdn.net",
      "libsql://db.turso.io",
      "secret-token",
    );
    const parsed = JSON.parse(blob);
    expect(parsed.d).toBe("libsql://db.turso.io");
    expect(parsed.t).toBe("secret-token");
  });

  test("buildSiteDataBlob omits db keys when empty", () => {
    const blob = buildSiteDataBlob("Test Site", "test.b-cdn.net");
    const parsed = JSON.parse(blob);
    expect(parsed.d).toBeUndefined();
    expect(parsed.t).toBeUndefined();
  });

  test("parseSiteDataBlob roundtrips with buildSiteDataBlob", () => {
    const blob = buildSiteDataBlob("My Site", "my.b-cdn.net");
    const parsed = parseSiteDataBlob(blob);
    expect(parsed.v).toBe(1);
    expect(parsed.n).toBe("My Site");
    expect(parsed.u).toBe("my.b-cdn.net");
  });

  test("parseSiteDataBlob handles legacy blobs without db keys", () => {
    const legacyBlob = JSON.stringify({
      v: 1,
      n: "Old Site",
      u: "old.b-cdn.net",
    });
    const parsed = parseSiteDataBlob(legacyBlob);
    expect(parsed.d).toBeUndefined();
    expect(parsed.t).toBeUndefined();
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
        id: 1,
        name: "Test",
        bunnyUrl: "test.bunny.run",
        dbUrl: "",
        dbToken: "",
        created: "2026-01-01",
      };
      const result = await builtSitesCrudTable.fromDb(site);
      expect(result).toEqual(site);
    });

    test("toDbValues builds encrypted blob from input", async () => {
      const values = await builtSitesCrudTable.toDbValues({
        name: "Test",
        bunnyUrl: "test.bunny.run",
        dbUrl: "libsql://test.turso.io",
        dbToken: "tok123",
      });
      expect(values.site_data).toBeTruthy();
      const parsed = parseSiteDataBlob(values.site_data as string);
      expect(parsed.n).toBe("Test");
      expect(parsed.u).toBe("test.bunny.run");
      expect(parsed.d).toBe("libsql://test.turso.io");
      expect(parsed.t).toBe("tok123");
    });

    test("update preserves existing name when only bunnyUrl provided", async () => {
      const site = await builtSitesCrudTable.insert({
        name: "Original",
        bunnyUrl: "original.bunny.run",
        dbUrl: "",
        dbToken: "",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        bunnyUrl: "new.bunny.run",
      });
      expect(updated!.name).toBe("Original");
      expect(updated!.bunnyUrl).toBe("new.bunny.run");
    });

    test("update preserves existing bunnyUrl when only name provided", async () => {
      const site = await builtSitesCrudTable.insert({
        name: "Original",
        bunnyUrl: "original.bunny.run",
        dbUrl: "",
        dbToken: "",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Updated",
      });
      expect(updated!.name).toBe("Updated");
      expect(updated!.bunnyUrl).toBe("original.bunny.run");
    });

    test("update preserves existing db credentials when not provided", async () => {
      const site = await builtSitesCrudTable.insert({
        name: "Original",
        bunnyUrl: "original.bunny.run",
        dbUrl: "libsql://db.turso.io",
        dbToken: "tok123",
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Updated",
      });
      expect(updated!.dbUrl).toBe("libsql://db.turso.io");
      expect(updated!.dbToken).toBe("tok123");
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
  });
});
