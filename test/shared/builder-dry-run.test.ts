/**
 * The site-build dry run: with `SITE_BUILD_DRY_RUN` set, the external calls a
 * site build makes answer from canned bodies — no network leaves the machine,
 * the subrequest budget still pays for every call with the same label a real
 * call would carry, and the canned bodies pass the real response parsers.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import { generateScheduledTaskKey } from "#shared/scheduled-keys.ts";
import { fetchLatestRelease } from "#shared/update.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { type EnvScope, withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

/** A fetch stub that fails the moment any real network is attempted. */
const noNetwork = (): ReturnType<typeof stubFetch> =>
  stubFetch(() => {
    throw new Error("dry run must not touch the network");
  });

/** The site-build dry-run flag, set for the current test only. */
const withDryRunEnv = (): EnvScope => withEnv({ SITE_BUILD_DRY_RUN: "true" });

describeWithEnv(
  "site-build dry run",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("answers the GitHub release lookup without network", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();

      const release = await fetchLatestRelease();

      expect(release.assetUrl).not.toBeNull();
      expect(release.assetUrl).toContain("dry-run.invalid");
    });

    test("deploys the latest release to a script without network", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();
      const { deployLatestReleaseToScript } = await import("#shared/update.ts");

      // Self-update shares the same call surface, so it dry-runs too: the
      // release lookup, the asset download, and the script deploy.
      const release = await deployLatestReleaseToScript(1);

      expect(release.assetUrl).toContain("dry-run.invalid");
    });

    test("creates a Bunny database without network", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();

      const result = await bunnyDbProvider.createDatabase("Dry run db");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.dbUrl).toContain("dry-run-");
        expect(result.value.dbUrl).toContain(".invalid");
        expect(result.value.dbToken).not.toBe("");
      }
    });

    test("creates an edge script without network", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();

      const result = await bunnyCdnApi.createEdgeScript(
        "Dry run script",
        "export {};",
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.defaultHostname).toMatch(/^dry-run-\d+\.invalid$/);
        expect(String(result.scriptId)).toMatch(/^\d+$/);
      }
    });

    test("sets secrets, updates the pull zone, and publishes without network", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();

      expect(await bunnyCdnApi.setEdgeScriptSecret(1, "DB_URL", "x")).toEqual({
        ok: true,
      });
      expect(
        await bunnyCdnApi.updatePullZone(1, { DisableCookies: false }),
      ).toEqual({ ok: true });
      expect(await bunnyCdnApi.publishEdgeScript(1)).toEqual({ ok: true });
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
          retainedId.value = site.hostingId === "" ? 0 : Number(site.hostingId);
        },
      );

      expect(result.ok).toBe(true);
      expect(retained).toBe(1);
      expect(retainedId.value).toBeGreaterThan(0);
      if (result.ok) {
        expect(result.defaultHostname).toMatch(/^dry-run-\d+\.invalid$/);
      }
      expect(generateScheduledTaskKey()).toBeTruthy();
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

    test("refuses the call when the budget is exhausted", async () => {
      using _env = withDryRunEnv();
      using _network = noNetwork();
      const {
        getSubrequestUsage,
        runWithSubrequestBudget,
        withSubrequestAllowance,
      } = await import("#shared/subrequest-budget.ts");

      const call = runWithSubrequestBudget(() =>
        withSubrequestAllowance(
          { database: 0, external: 0, total: 0 },
          async () => {
            await bunnyCdnApi.setEdgeScriptSecret(1, "DB_URL", "x");
            return getSubrequestUsage();
          },
        ),
      );

      await expect(call).rejects.toThrow("Subrequest allowance exceeded");
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

    test("performs the real fetch when the flag is off", async () => {
      using _key = withEnv({ BUNNY_API_KEY: "test-bunny-key" });
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
