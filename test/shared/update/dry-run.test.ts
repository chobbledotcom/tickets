/**
 * The update side of the site-build dry run: with `SITE_BUILD_DRY_RUN` set,
 * the GitHub release lookup and asset download answer from canned values with
 * no network, each still paying the subrequest budget for its call and
 * naming its operation in the budget's refusal.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  deployLatestReleaseToDeno,
  fetchLatestRelease,
} from "#shared/update.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

/** A fetch stub that fails the moment any real network is attempted, so a
 * dry-run test proves the canned surface answers instead. */
const noNetwork = (): ReturnType<typeof stubFetch> =>
  stubFetch(() => {
    throw new Error("dry run must not touch the network");
  });

describeWithEnv(
  "update site-build dry run",
  { db: true, env: { SITE_BUILD_DRY_RUN: "true" } },
  () => {
    test("answers the release lookup with the canned release", async () => {
      using _network = noNetwork();

      expect(await fetchLatestRelease()).toEqual({
        assetUrl: "https://dry-run.invalid/bunny-script.ts",
        name: "Dry-run release",
        publishedAt: "",
        tagName: "dry-run",
      });
    });

    test("deploys the latest release to a script offline", async () => {
      using _network = noNetwork();
      const { deployLatestReleaseToScript } = await import("#shared/update.ts");

      expect(await deployLatestReleaseToScript(1)).toEqual({
        assetUrl: "https://dry-run.invalid/bunny-script.ts",
        name: "Dry-run release",
        publishedAt: "",
        tagName: "dry-run",
      });
    });

    test("the release lookup still pays the subrequest budget", async () => {
      using _network = noNetwork();
      const call = runWithSubrequestBudget(() =>
        withSubrequestAllowance({ database: 0, external: 0, total: 0 }, () =>
          fetchLatestRelease(),
        ),
      );

      // The refusal names the operation, so the count's label is pinned too.
      await expect(call).rejects.toThrow(
        "Blocked external operation: GitHub release lookup",
      );
    });

    test("the asset download still pays the subrequest budget", async () => {
      using _network = noNetwork();
      const call = runWithSubrequestBudget(() =>
        withSubrequestAllowance(
          // One external call covers the lookup; the download is the second.
          { database: 0, external: 1, total: 1 },
          () => deployLatestReleaseToDeno("app-1"),
        ),
      );

      await expect(call).rejects.toThrow(
        "Blocked external operation: GitHub release download",
      );
    });

    test("deploys a real asset's own code, not the canned one", async () => {
      // deployRelease carries an arbitrary asset URL, and only the dry run's
      // own synthetic release is canned. The captured deploy proves the
      // foreign URL's downloaded code is the code that reaches it, so a
      // dry-run environment cannot quietly ship the canned source.
      using _fetch = stubFetch(new Response("console.log('the real asset')"));
      const { bunnyCdnApi } = await import("#shared/bunny-cdn.ts");
      const { deployRelease } = await import("#shared/update.ts");
      let deployedCode = "";
      const deployStub = stub(bunnyCdnApi, "deployScriptCode", (code) => {
        deployedCode = code;
        return Promise.resolve({ ok: true as const });
      });
      try {
        await deployRelease("https://example.com/asset.ts", "9001");
      } finally {
        deployStub.restore();
      }

      expect(_fetch.calls[0]!.args[0]).toBe("https://example.com/asset.ts");
      expect(deployedCode).toBe("console.log('the real asset')");
    });
  },
);
