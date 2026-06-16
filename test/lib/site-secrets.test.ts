import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { collectHostSecrets } from "#shared/builder.ts";
import { bunnyCdnApi, type EdgeScriptSecret } from "#shared/bunny-cdn.ts";
import type { BuiltSite } from "#shared/db/built-sites.ts";
import {
  addMissingSiteSecrets,
  expectedSiteSecrets,
  loadSiteSecretsStatus,
} from "#shared/site-secrets.ts";
import { describeWithEnv, testBuiltSite, withMocks } from "#test-utils";

/** Build a Bunny secret-list entry (name + metadata; the API never returns values). */
const secret = (name: string): EdgeScriptSecret => ({
  Id: 1,
  LastModified: "2026-01-01T00:00:00Z",
  Name: name,
});

/** Stub bunnyCdnApi.listEdgeScriptSecrets to return the given names. */
const stubList = (names: string[]) =>
  stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
    Promise.resolve({ ok: true as const, secrets: names.map(secret) }),
  );

const buildSite = (overrides: Partial<BuiltSite> = {}): BuiltSite =>
  testBuiltSite({
    bunnyScriptId: "555",
    dbToken: "tok-123",
    dbUrl: "libsql://site.turso.io",
    ...overrides,
  });

/** Names we'd copy to a fresh build of the standard test site. */
const expectedNamesFor = (site: BuiltSite): string[] =>
  expectedSiteSecrets(site).map(([name]) => name);

describeWithEnv(
  "collectHostSecrets",
  { env: { NTFY_URL: "https://ntfy.example.com/t" } },
  () => {
    test("includes host env vars that are set and skips those that are not", () => {
      const pairs = collectHostSecrets();
      expect(pairs).toContainEqual(["NTFY_URL", "https://ntfy.example.com/t"]);
      // STORAGE_ZONE_KEY is not set in this env, so it must be absent.
      expect(pairs.map(([name]) => name)).not.toContain("STORAGE_ZONE_KEY");
    });
  },
);

describeWithEnv(
  "expectedSiteSecrets",
  { env: { NTFY_URL: "https://ntfy.example.com/t" } },
  () => {
    test("includes base credentials plus host secrets", () => {
      const pairs = expectedSiteSecrets(buildSite());
      expect(pairs).toContainEqual(["DB_URL", "libsql://site.turso.io"]);
      expect(pairs).toContainEqual(["DB_TOKEN", "tok-123"]);
      expect(pairs).toContainEqual(["BUNNY_SCRIPT_ID", "555"]);
      expect(pairs).toContainEqual(["NTFY_URL", "https://ntfy.example.com/t"]);
    });

    test("never includes DB_ENCRYPTION_KEY (it cannot be reproduced)", () => {
      expect(expectedNamesFor(buildSite())).not.toContain("DB_ENCRYPTION_KEY");
    });

    test("omits base credentials the site has no value for", () => {
      const names = expectedNamesFor(
        buildSite({ bunnyScriptId: "555", dbToken: "", dbUrl: "" }),
      );
      expect(names).not.toContain("DB_URL");
      expect(names).not.toContain("DB_TOKEN");
      expect(names).toContain("BUNNY_SCRIPT_ID");
    });

    test("includes only host secrets when the site has no base values", () => {
      const names = expectedNamesFor(
        buildSite({ bunnyScriptId: "", dbToken: "", dbUrl: "" }),
      );
      expect(names).not.toContain("BUNNY_SCRIPT_ID");
      expect(names).not.toContain("DB_URL");
      expect(names).not.toContain("DB_TOKEN");
      expect(names).toContain("NTFY_URL");
    });
  },
);

describeWithEnv(
  "loadSiteSecretsStatus",
  { env: { BUNNY_API_KEY: "k", NTFY_URL: "https://ntfy.example.com/t" } },
  () => {
    test("diffs expected secrets against the live list", async () => {
      const site = buildSite();
      // Live list has every expected secret except NTFY_URL, plus an extra
      // (DB_ENCRYPTION_KEY) that is present but not part of the expected set.
      const present = expectedNamesFor(site)
        .filter((n) => n !== "NTFY_URL")
        .concat("DB_ENCRYPTION_KEY");
      await withMocks(
        () => stubList(present),
        async () => {
          const view = await loadSiteSecretsStatus(site);
          expect(view.ok).toBe(true);
          if (!view.ok) return;
          expect(view.missing).toEqual(["NTFY_URL"]);
          // A live secret outside the expected set is never flagged as missing.
          expect(view.missing).not.toContain("DB_ENCRYPTION_KEY");
          expect(view.present).toContain("DB_ENCRYPTION_KEY");
          expect(view.expected).toContain("NTFY_URL");
        },
      );
    });

    test("reports nothing missing when every expected secret is live", async () => {
      const site = buildSite();
      await withMocks(
        () => stubList(expectedNamesFor(site)),
        async () => {
          const view = await loadSiteSecretsStatus(site);
          expect(view.ok).toBe(true);
          if (view.ok) expect(view.missing).toEqual([]);
        },
      );
    });

    test("surfaces an API error instead of throwing", async () => {
      await withMocks(
        () =>
          stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
            Promise.resolve({
              error: "List secrets failed (500)",
              ok: false as const,
            }),
          ),
        async () => {
          const view = await loadSiteSecretsStatus(buildSite());
          expect(view).toEqual({
            error: "List secrets failed (500)",
            ok: false,
          });
        },
      );
    });

    test("catches a thrown fetch error", async () => {
      await withMocks(
        () =>
          stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
            Promise.reject(new Error("network down")),
          ),
        async () => {
          const view = await loadSiteSecretsStatus(buildSite());
          expect(view.ok).toBe(false);
          if (!view.ok) expect(view.error).toContain("network down");
        },
      );
    });

    test("refuses a site with no script id", async () => {
      const view = await loadSiteSecretsStatus(
        buildSite({ bunnyScriptId: "" }),
      );
      expect(view.ok).toBe(false);
      if (!view.ok) expect(view.error).toContain("no Bunny script ID");
    });
  },
);

describeWithEnv("loadSiteSecretsStatus without an API key", { env: {} }, () => {
  test("refuses when BUNNY_API_KEY is not configured", async () => {
    const view = await loadSiteSecretsStatus(buildSite());
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error).toContain("BUNNY_API_KEY");
  });
});

describeWithEnv(
  "addMissingSiteSecrets",
  { env: { BUNNY_API_KEY: "k", NTFY_URL: "https://ntfy.example.com/t" } },
  () => {
    test("sets only the missing secrets and never overwrites existing ones", async () => {
      const site = buildSite();
      // Everything expected is already live except NTFY_URL.
      const present = expectedNamesFor(site).filter((n) => n !== "NTFY_URL");
      const setCalls: [string, string][] = [];
      await withMocks(
        () => ({
          listStub: stubList(present),
          setStub: stub(
            bunnyCdnApi,
            "setEdgeScriptSecret",
            (_id: number, name: string, value: string) => {
              setCalls.push([name, value]);
              return Promise.resolve({ ok: true as const });
            },
          ),
        }),
        async () => {
          const result = await addMissingSiteSecrets(site);
          expect(result).toEqual({ added: ["NTFY_URL"], ok: true });
          // Only the missing secret is written; existing ones are left alone.
          expect(setCalls).toEqual([
            ["NTFY_URL", "https://ntfy.example.com/t"],
          ]);
        },
      );
    });

    test("re-verifies live secrets first, so it skips ones that now exist", async () => {
      const site = buildSite();
      const setCalls: string[] = [];
      await withMocks(
        () => ({
          // The live list already has every expected secret (added meanwhile).
          listStub: stubList(expectedNamesFor(site)),
          setStub: stub(bunnyCdnApi, "setEdgeScriptSecret", (_i, n: string) => {
            setCalls.push(n);
            return Promise.resolve({ ok: true as const });
          }),
        }),
        async () => {
          const result = await addMissingSiteSecrets(site);
          expect(result).toEqual({ added: [], ok: true });
          expect(setCalls).toEqual([]);
        },
      );
    });

    test("returns the error when a secret fails to set", async () => {
      await withMocks(
        () => ({
          listStub: stubList([]),
          setStub: stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
            Promise.resolve({
              error: "Set secret DB_URL failed (403)",
              ok: false as const,
            }),
          ),
        }),
        async () => {
          const result = await addMissingSiteSecrets(buildSite());
          expect(result).toEqual({
            error: "Set secret DB_URL failed (403)",
            ok: false,
          });
        },
      );
    });

    test("returns the error when the live list cannot be read", async () => {
      await withMocks(
        () =>
          stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
            Promise.resolve({
              error: "List secrets failed (401)",
              ok: false as const,
            }),
          ),
        async () => {
          const result = await addMissingSiteSecrets(buildSite());
          expect(result).toEqual({
            error: "List secrets failed (401)",
            ok: false,
          });
        },
      );
    });

    test("refuses a site with no script id", async () => {
      const result = await addMissingSiteSecrets(
        buildSite({ bunnyScriptId: "" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("no Bunny script ID");
    });
  },
);
