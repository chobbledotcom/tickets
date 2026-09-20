/**
 * The site-build dry run's own module: with `SITE_BUILD_DRY_RUN` set, a mapped
 * call answers from a canned body with no network, the subrequest budget still
 * pays for the call, and successive canned builds draw successive ids. The
 * per-provider canned bodies are pinned by each provider's own mirrored
 * suite (update.test.ts, bunny-db.test.ts, bunny-cdn/).
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

/** A fetch stub that fails the moment any real network is attempted. */
const noNetwork = (): ReturnType<typeof stubFetch> =>
  stubFetch(() => {
    throw new Error("dry run must not touch the network");
  });

/** The site-build dry-run flag, set for the current test only. */
const withDryRunEnv = (): ReturnType<typeof withEnv> =>
  withEnv({ SITE_BUILD_DRY_RUN: "true" });

describeWithEnv(
  "site-build dry run",
  { db: true, env: { BUNNY_API_KEY: "test-key", CAN_BUILD_SITES: "true" } },
  () => {
    test("draws successive ids for successive canned creations", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();

      // The first two canned creations in this process take ids 1 and 2, so
      // the counter starts at zero and advances by exactly one per creation.
      const first = await bunnyCdnApi.createEdgeScript("First", "export {};");
      const second = await bunnyCdnApi.createEdgeScript("Second", "export {};");

      expect(first).toEqual({
        defaultHostname: "dry-run-1.invalid",
        ok: true,
        pullZoneId: 1,
        scriptId: 1,
      });
      expect(second).toEqual({
        defaultHostname: "dry-run-2.invalid",
        ok: true,
        pullZoneId: 2,
        scriptId: 2,
      });
    });

    test("answers a mapped call with a canned 200", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();
      const { dryRunOrFetchText } = await import("#shared/builder-dry-run.ts");

      const response = await dryRunOrFetchText(
        "https://api.bunny.net/compute/script/1/secrets",
        () => ({ headers: {} }),
      );

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(response.text).toBe("{}");
    });

    test("answers a database token request with the canned token", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();
      const { dryRunOrFetchText } = await import("#shared/builder-dry-run.ts");

      const tokenResponse = await dryRunOrFetchText(
        "https://api.bunny.net/database/v2/databases/1/auth/generate",
        () => ({ headers: {} }),
      );

      expect(JSON.parse(tokenResponse.text)).toEqual({
        token: "dry-run-db-token",
      });
    });

    test("answers a database read with an id-derived canned URL", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();
      const { dryRunOrFetchText } = await import("#shared/builder-dry-run.ts");

      const getResponse = await dryRunOrFetchText(
        "https://api.bunny.net/database/v2/databases/7",
        () => ({ headers: {} }),
      );

      expect(JSON.parse(getResponse.text)).toEqual({
        db: {
          db_id: "7",
          name: "Dry run",
          url: "libsql://dry-run-7.invalid",
        },
      });
    });

    test("counts every canned call against the subrequest budget", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();
      const { getSubrequestUsage, runWithSubrequestBudget } = await import(
        "#shared/subrequest-budget.ts"
      );

      const usage = runWithSubrequestBudget(async () => {
        await bunnyCdnApi.setEdgeScriptSecret(1, "DB_URL", "x");
        return getSubrequestUsage().external;
      });

      expect(await usage).toBe(1);
    });

    test("builds and retains a whole site through the canned surface", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();
      let retained = 0;
      const retainedId = { value: 0 };

      const result = await builderApi.buildSite(
        { siteName: "00001" },
        async (site) => {
          retained += 1;
          retainedId.value = Number(site.hostingId);
        },
      );

      expect(result.ok).toBe(true);
      expect(retained).toBe(1);
      expect(retainedId.value).toBeGreaterThan(0);
    });

    test("performs the real fetch for a URL outside the surface", async () => {
      using _env = withDryRunEnv();
      using _network = stubFetch(() => new Response("{}", { status: 200 }));
      const { dryRunOrFetchText } = await import("#shared/builder-dry-run.ts");

      const response = await dryRunOrFetchText(
        "https://unmapped.example/records",
        () => ({ headers: {} }),
      );

      expect(response.ok).toBe(true);
      expect(_network.calls.length).toBe(1);
    });

    test("performs the real fetch for a near-miss of a mapped endpoint", async () => {
      using _env = withDryRunEnv();
      using _network = stubFetch(() => new Response("{}", { status: 200 }));
      const { dryRunOrFetchText } = await import("#shared/builder-dry-run.ts");

      // Near misses of mapped shapes: another origin that ends like a mapped
      // path, a pull-zone action the build never takes, a database path
      // deeper than the read endpoint, and query-bearing versions of mapped
      // paths. Every one must reach the real network.
      const nearMisses = [
        "https://unmapped.example/compute/script",
        "https://unmapped.example/pullzone/123",
        "https://api.bunny.net/pullzone/123/addHostname",
        "https://api.bunny.net/database/v2/databases/7/backups",
        "https://api.bunny.net/database/v2/databases/7?backup=1",
        "https://api.bunny.net/compute/script/1/secrets?refresh=1",
      ];
      for (const url of nearMisses) {
        const response = await dryRunOrFetchText(url, () => ({ headers: {} }));
        expect(response.ok, `at ${url}`).toBe(true);
      }
      expect(_network.calls.length).toBe(nearMisses.length);
    });

    test("performs the real fetch when the flag is off", async () => {
      using _env = withEnv({ SITE_BUILD_DRY_RUN: undefined });
      using _network = stubFetch(() => new Response("{}", { status: 200 }));
      const { getSubrequestUsage, runWithSubrequestBudget } = await import(
        "#shared/subrequest-budget.ts"
      );

      const usage = await runWithSubrequestBudget(async () => {
        expect(await bunnyCdnApi.setEdgeScriptSecret(1, "DB_URL", "x")).toEqual(
          { ok: true },
        );
        expect(_network.calls.length).toBe(1);
        return getSubrequestUsage().external;
      });

      expect(usage).toBe(1);
    });
  },
);
