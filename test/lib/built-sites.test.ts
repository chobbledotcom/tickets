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
});
