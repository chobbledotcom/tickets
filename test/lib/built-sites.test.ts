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

  test("parseSiteDataBlob roundtrips with buildSiteDataBlob", () => {
    const blob = buildSiteDataBlob("My Site", "my.b-cdn.net");
    const parsed = parseSiteDataBlob(blob);
    expect(parsed.v).toBe(1);
    expect(parsed.n).toBe("My Site");
    expect(parsed.u).toBe("my.b-cdn.net");
  });

  test("insertBuiltSite creates a row with encrypted site_data", async () => {
    const row = await insertBuiltSite("Alpha Site", "alpha.b-cdn.net");
    expect(row.id).toBe(1);
    expect(row.created).toBeTruthy();
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
        created: "2026-01-01",
      };
      const result = await builtSitesCrudTable.fromDb(site);
      expect(result).toEqual(site);
    });

    test("toDbValues builds encrypted blob from input", async () => {
      const values = await builtSitesCrudTable.toDbValues({
        name: "Test",
        bunnyUrl: "test.bunny.run",
      });
      expect(values.site_data).toBeTruthy();
      const parsed = parseSiteDataBlob(values.site_data as string);
      expect(parsed.n).toBe("Test");
      expect(parsed.u).toBe("test.bunny.run");
    });

    test("update preserves existing name when only bunnyUrl provided", async () => {
      const site = await builtSitesCrudTable.insert({
        name: "Original",
        bunnyUrl: "original.bunny.run",
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
      });
      const updated = await builtSitesCrudTable.update(site.id, {
        name: "Updated",
      });
      expect(updated!.name).toBe("Updated");
      expect(updated!.bunnyUrl).toBe("original.bunny.run");
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
