import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  buildSiteDataBlob,
  getAllBuiltSites,
  insertBuiltSite,
  parseSiteDataBlob,
} from "#lib/db/built-sites.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("built-sites", { db: true }, () => {
  test("buildSiteDataBlob creates valid JSON with version", () => {
    const blob = buildSiteDataBlob("Test Site", "test.bunny.run");
    const parsed = JSON.parse(blob);
    expect(parsed.v).toBe(1);
    expect(parsed.n).toBe("Test Site");
    expect(parsed.u).toBe("test.bunny.run");
  });

  test("parseSiteDataBlob roundtrips with buildSiteDataBlob", () => {
    const blob = buildSiteDataBlob("My Site", "my.bunny.run");
    const parsed = parseSiteDataBlob(blob);
    expect(parsed.v).toBe(1);
    expect(parsed.n).toBe("My Site");
    expect(parsed.u).toBe("my.bunny.run");
  });

  test("insertBuiltSite creates a row with encrypted site_data", async () => {
    const row = await insertBuiltSite("Alpha Site", "alpha.bunny.run");
    expect(row.id).toBe(1);
    expect(row.created).toBeTruthy();
  });

  test("getAllBuiltSites returns decrypted sites sorted by name", async () => {
    await insertBuiltSite("Charlie", "charlie.bunny.run");
    await insertBuiltSite("Alpha", "alpha.bunny.run");
    await insertBuiltSite("Bravo", "bravo.bunny.run");

    const sites = await getAllBuiltSites();
    expect(sites).toHaveLength(3);
    expect(sites[0]!.name).toBe("Alpha");
    expect(sites[0]!.bunnyUrl).toBe("alpha.bunny.run");
    expect(sites[1]!.name).toBe("Bravo");
    expect(sites[2]!.name).toBe("Charlie");
  });

  test("getAllBuiltSites returns empty array when no sites exist", async () => {
    const sites = await getAllBuiltSites();
    expect(sites).toHaveLength(0);
  });
});
