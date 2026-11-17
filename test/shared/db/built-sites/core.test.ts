import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { parseSiteDataBlob, type SiteDataBlob } from "#db/built-sites/blob.ts";
import type { BuiltSiteFormInput } from "#db/built-sites/types.ts";
import {
  builtSites,
  findBuiltSiteById,
  insertBuiltSite,
} from "#db/built-sites.ts";
import { execute } from "#db/client.ts";
import { records } from "#db/record-table.ts";
import { sql } from "#db/sql.ts";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";
import { storedSiteRow } from "./fixtures.ts";

/** The form every site-data case starts from, so each case lists only the
 *  fields it is about. */
const BASE_FORM: Partial<BuiltSiteFormInput> = {
  name: "Test Site",
  siteUrl: "test.b-cdn.net",
};

const formBlob = async (input: Partial<BuiltSiteFormInput>) =>
  (await storedSiteRow({ ...BASE_FORM, ...input })).blob;

/** One stored-site case: the fields it adds to BASE_FORM, the blob keys the
 *  stored JSON must carry with which value, and the keys it must omit. */
const siteDataCases: {
  title: string;
  input: Partial<BuiltSiteFormInput>;
  present?: Partial<SiteDataBlob>;
  absent?: readonly (keyof SiteDataBlob)[];
}[] = [
  {
    input: {},
    present: {
      dp: "bunny",
      hp: "bunny",
      n: "Test Site",
      u: "test.b-cdn.net",
      v: 2,
    },
    title: "storing a site creates valid site-data JSON",
  },
  {
    input: { dbProvider: "turso", hostingProvider: "deno" },
    present: { dp: "turso", hp: "deno" },
    title: "storing a site includes selected providers",
  },
  {
    input: { dbToken: "secret-token", dbUrl: "libsql://db.turso.io" },
    present: { d: "libsql://db.turso.io", t: "secret-token" },
    title: "storing a site includes db credentials when provided",
  },
  {
    absent: ["d", "t"],
    input: {},
    title: "storing a site omits db keys when empty",
  },
  {
    input: { hostingId: "98765" },
    present: { s: "98765" },
    title: "storing a site includes hosting id when provided",
  },
  {
    absent: ["s"],
    input: {},
    title: "storing a site omits hosting id when empty",
  },
];

describeWithEnv("built-site storage", { db: true }, () => {
  for (const siteCase of siteDataCases) {
    test(siteCase.title, async () => {
      const parsed = await formBlob(siteCase.input);
      if (siteCase.present !== undefined) {
        expect(parsed).toMatchObject(siteCase.present);
      }
      for (const key of siteCase.absent ?? []) {
        expect(Object.hasOwn(parsed, key)).toBe(false);
      }
    });
  }

  test("parseSiteDataBlob handles legacy blobs without optional keys", () => {
    const parsed = parseSiteDataBlob(
      JSON.stringify({ n: "Old Site", u: "old.b-cdn.net", v: 1 }),
    );
    expect(Object.hasOwn(parsed, "d")).toBe(false);
    expect(Object.hasOwn(parsed, "t")).toBe(false);
    expect(Object.hasOwn(parsed, "s")).toBe(false);
  });

  test("insertBuiltSite creates a row with encrypted site data", async () => {
    const row = await insertBuiltSite("Alpha Site", "alpha.b-cdn.net");
    expect(row.id).toBe(1);
    expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
    expect(site).toMatchObject({
      dbToken: "secret-token",
      dbUrl: "libsql://db.turso.io",
      hostingId: "12345",
    });
  });

  test("insertBuiltSite defaults optional strings", async () => {
    await insertBuiltSite("Default Site", "default.b-cdn.net");
    const site = (await builtSites.getAll())[0]!;
    expect(site).toMatchObject({ dbToken: "", dbUrl: "", hostingId: "" });
  });

  test("getAll returns decrypted sites sorted by name", async () => {
    const alpha = await insertBuiltSite("Alpha", "alpha.b-cdn.net");
    const zulu = await insertBuiltSite("Zulu", "zulu.b-cdn.net");
    await execute(
      sql`UPDATE built_sites SET created = ${"2025-01-01T00:00:00Z"} WHERE id = ${alpha.id}`,
    );
    await execute(
      sql`UPDATE built_sites SET created = ${"2026-01-01T00:00:00Z"} WHERE id = ${zulu.id}`,
    );
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
    const site = await findBuiltSiteById(row.id);
    expect(site?.scheduledTaskKey).toBe(TEST_SCHEDULED_KEY);
  });

  test("rejects an invalid scheduler key before inserting the site", async () => {
    await expect(
      insertBuiltSite(
        "Invalid scheduled key",
        "invalid-key.example.test",
        "",
        "",
        false,
        "",
        undefined,
        "bunny",
        "bunny",
        "not-a-scheduled-key",
      ),
    ).rejects.toThrow();
    expect(await builtSites.getAll()).toEqual([]);
  });

  test("legacy empty renewal tokens remain empty strings", async () => {
    const row = await records.built_sites.insert({
      created: "2026-01-01T00:00:00Z",
      siteData: JSON.stringify({
        n: "Legacy renewal",
        rt: "",
        u: "legacy.example.test",
        v: 1,
      }),
    });
    expect((await findBuiltSiteById(row.id))?.renewalToken).toBe("");
  });
});
