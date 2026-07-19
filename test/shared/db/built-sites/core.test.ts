import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import {
  builtSites,
  builtSitesCrudTable,
  DEFAULT_UPDATE_TIER,
  insertBuiltSite,
  isUpdateTier,
  parseSiteDataBlob,
  providerOrBunny,
  siteAcceptsDeployTier,
  siteBaseUrl,
  UPDATE_TIERS,
} from "#shared/db/built-sites.ts";
import { execute } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

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

describe("update tiers", () => {
  test("UPDATE_TIERS is ordered most- to least-eager", () => {
    expect(UPDATE_TIERS).toEqual(["alpha", "beta", "release"]);
  });

  test("DEFAULT_UPDATE_TIER is the most conservative channel", () => {
    expect(DEFAULT_UPDATE_TIER).toBe("release");
  });

  test("isUpdateTier accepts known channels and rejects anything else", () => {
    for (const tier of UPDATE_TIERS) expect(isUpdateTier(tier)).toBe(true);
    for (const bad of ["", "ALPHA", "stable", "rel", "release "]) {
      expect(isUpdateTier(bad)).toBe(false);
    }
  });

  test("a release deploy reaches every channel", () => {
    for (const siteTier of UPDATE_TIERS) {
      expect(siteAcceptsDeployTier(siteTier, "release")).toBe(true);
    }
  });

  test("a beta deploy reaches beta + alpha sites but not release-only", () => {
    expect(siteAcceptsDeployTier("alpha", "beta")).toBe(true);
    expect(siteAcceptsDeployTier("beta", "beta")).toBe(true);
    expect(siteAcceptsDeployTier("release", "beta")).toBe(false);
  });

  test("an alpha deploy reaches only alpha sites", () => {
    expect(siteAcceptsDeployTier("alpha", "alpha")).toBe(true);
    expect(siteAcceptsDeployTier("beta", "alpha")).toBe(false);
    expect(siteAcceptsDeployTier("release", "alpha")).toBe(false);
  });
});

describe("built-site providers", () => {
  test("keeps a selected non-Bunny provider", () => {
    expect(providerOrBunny("deno", "deno")).toBe("deno");
    expect(providerOrBunny("turso", "turso")).toBe("turso");
  });

  test("uses Bunny when the named provider is not selected", () => {
    expect(providerOrBunny(null, "deno")).toBe("bunny");
    expect(providerOrBunny("bunny", "turso")).toBe("bunny");
  });

  test("parses every non-Bunny provider", () => {
    const parsed = parseSiteDataBlob(
      JSON.stringify({
        dp: "turso",
        hp: "deno",
        n: "Provider site",
        u: "provider.example.test",
        v: 2,
      }),
    );
    expect(parsed.dp).toBe("turso");
    expect(parsed.hp).toBe("deno");
  });
});

describeWithEnv("built-site storage", { db: true }, () => {
  test("toDbValues creates valid site-data JSON", async () => {
    const parsed = await formBlob({
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed).toMatchObject({
      dp: "bunny",
      hp: "bunny",
      n: "Test Site",
      u: "test.b-cdn.net",
      v: 2,
    });
  });

  test("toDbValues includes selected providers", async () => {
    const parsed = await formBlob({
      dbProvider: "turso",
      hostingProvider: "deno",
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.dp).toBe("turso");
    expect(parsed.hp).toBe("deno");
  });

  test("toDbValues includes db credentials when provided", async () => {
    const parsed = await formBlob({
      dbToken: "secret-token",
      dbUrl: "libsql://db.turso.io",
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.d).toBe("libsql://db.turso.io");
    expect(parsed.t).toBe("secret-token");
  });

  test("toDbValues omits db keys when empty", async () => {
    const parsed = await formBlob({
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.d).toBeUndefined();
    expect(parsed.t).toBeUndefined();
  });

  test("toDbValues includes hosting id when provided", async () => {
    const parsed = await formBlob({
      hostingId: "98765",
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.s).toBe("98765");
  });

  test("toDbValues omits hosting id when empty", async () => {
    const parsed = await formBlob({
      name: "Test Site",
      siteUrl: "test.b-cdn.net",
    });
    expect(parsed.s).toBeUndefined();
  });

  test("parseSiteDataBlob handles legacy blobs without optional keys", () => {
    const parsed = parseSiteDataBlob(
      JSON.stringify({ n: "Old Site", u: "old.b-cdn.net", v: 1 }),
    );
    expect(parsed.d).toBeUndefined();
    expect(parsed.t).toBeUndefined();
    expect(parsed.s).toBeUndefined();
  });

  test("insertBuiltSite creates a row with encrypted site data", async () => {
    const row = await insertBuiltSite("Alpha Site", "alpha.b-cdn.net");
    expect(row.id).toBe(1);
    expect(row.created).toBeTruthy();
  });

  test("insertBuiltSite stores credentials and hosting id", async () => {
    await insertBuiltSite(
      "Configured Site",
      "configured.b-cdn.net",
      "libsql://db.turso.io",
      "secret-token",
      false,
      "12345",
    );
    const site = (await builtSites.getAll())[0]!;
    expect(site.dbUrl).toBe("libsql://db.turso.io");
    expect(site.dbToken).toBe("secret-token");
    expect(site.hostingId).toBe("12345");
  });

  test("insertBuiltSite defaults optional strings", async () => {
    await insertBuiltSite("Default Site", "default.b-cdn.net");
    const site = (await builtSites.getAll())[0]!;
    expect(site.dbUrl).toBe("");
    expect(site.dbToken).toBe("");
    expect(site.hostingId).toBe("");
  });

  test("getAll returns decrypted sites sorted by name", async () => {
    const alpha = await insertBuiltSite("Alpha", "alpha.b-cdn.net");
    const zulu = await insertBuiltSite("Zulu", "zulu.b-cdn.net");
    await execute("UPDATE built_sites SET created = ? WHERE id = ?", [
      "2025-01-01T00:00:00Z",
      alpha.id,
    ]);
    await execute("UPDATE built_sites SET created = ? WHERE id = ?", [
      "2026-01-01T00:00:00Z",
      zulu.id,
    ]);
    expect((await builtSites.getAll()).map(({ name }) => name)).toEqual([
      "Alpha",
      "Zulu",
    ]);
  });

  test("getAll returns an empty array when no sites exist", async () => {
    expect(await builtSites.getAll()).toEqual([]);
  });

  test("cache stats identify the built-site cache", () => {
    expect(
      getAllCacheStats().filter(({ name }) => name === "built_sites"),
    ).toHaveLength(1);
  });

  test("the scheduler key round-trips through encrypted site data", async () => {
    const row = await insertBuiltSite(
      "Scheduled Site",
      "scheduled.example.test",
      "",
      "",
      false,
      "",
      undefined,
      "bunny",
      "bunny",
      TEST_SCHEDULED_KEY,
    );
    const site = await builtSitesCrudTable.findById(row.id);
    expect(site?.scheduledTaskKey).toBe(TEST_SCHEDULED_KEY);
  });

  test("legacy empty renewal tokens remain empty strings", async () => {
    const row = await builtSites.table.insert({
      siteData: JSON.stringify({
        n: "Legacy renewal",
        rt: "",
        u: "legacy.example.test",
        v: 1,
      }),
    });
    expect((await builtSitesCrudTable.findById(row.id))?.renewalToken).toBe("");
  });
});
