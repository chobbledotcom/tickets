import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  insertBuiltSite,
  requireBuiltSiteByIdPrimary,
} from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import {
  completeDatabaseKeyRotation,
  startDatabaseKeyRotation,
} from "#shared/database-key-rotation.ts";
import { okResult, requireSuccess } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withMocks } from "#test-utils/mocks.ts";

const START_MS = 1_700_000_000_000;

type ProviderSteps = Partial<{
  invalidate: typeof bunnyDbProvider.invalidateDatabaseTokens;
  issue: typeof bunnyDbProvider.issueDatabaseToken;
  push: typeof bunnyCdnApi.setEdgeScriptSecret;
}>;

interface RotationObservations {
  clock: FakeTime;
  issued: { calls: readonly unknown[] };
  removed: { calls: readonly unknown[] };
}

/** Each test can hold one provider boundary while it sends another command. */
const rotationFakes = (steps: ProviderSteps) => ({
  clock: new FakeTime(START_MS),
  issued: stub(
    bunnyDbProvider,
    "issueDatabaseToken",
    steps.issue ?? (() => Promise.resolve(okResult("new-key"))),
  ),
  pushed: stub(
    bunnyCdnApi,
    "setEdgeScriptSecret",
    steps.push ?? (() => Promise.resolve(okResult(undefined))),
  ),
  removed: stub(
    bunnyDbProvider,
    "invalidateDatabaseTokens",
    steps.invalidate ?? (() => Promise.resolve(okResult(undefined))),
  ),
});

const withRotation = (
  steps: ProviderSteps,
  run: (site: BuiltSite, fakes: RotationObservations) => Promise<void>,
): Promise<void> =>
  withMocks(
    () => rotationFakes(steps),
    async (fakes) => {
      const { id } = await insertBuiltSite(
        "Race site",
        "https://race.test",
        "libsql://race.lite.bunnydb.net",
        "old-key",
        false,
        "9100",
      );
      await run(await requireBuiltSiteByIdPrimary(id), fakes);
    },
  );

describeWithEnv(
  "database key provider races",
  {
    db: true,
    env: { BUNNY_API_KEY: "host-key" },
  },
  () => {
    test("does not issue while a newer invalidation is in flight", async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let removals = 0;
      await withRotation(
        {
          invalidate: async () => {
            if (++removals === 2) {
              entered.resolve();
              await release.promise;
            }
            return okResult(undefined);
          },
        },
        async (site, { clock, issued }) => {
          const first = requireSuccess(await startDatabaseKeyRotation(site));
          clock.tick(60_000);
          const second = startDatabaseKeyRotation(site);
          await entered.promise;
          try {
            const completed = await completeDatabaseKeyRotation(site, first);
            expect([completed.ok, issued.calls.length]).toEqual([false, 0]);
          } finally {
            release.resolve();
            await second;
          }
        },
      );
    });

    test("keeps the claim until the host receives its key", async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await withRotation(
        {
          push: async () => {
            entered.resolve();
            await release.promise;
            return okResult(undefined);
          },
        },
        async (site, { clock, removed }) => {
          const started = requireSuccess(await startDatabaseKeyRotation(site));
          clock.tick(60_000);
          const completion = completeDatabaseKeyRotation(site, started);
          await entered.promise;
          try {
            const overlapping = await startDatabaseKeyRotation(site);
            expect([overlapping.ok, removed.calls.length]).toEqual([false, 1]);
            expect((await completeDatabaseKeyRotation(site, started)).ok).toBe(
              false,
            );
          } finally {
            release.resolve();
            await completion;
          }
        },
      );
    });

    test("gives same-tick restarts distinct identities and enforces their pause", () =>
      withRotation({}, async (site, { clock, issued }) => {
        const first = requireSuccess(await startDatabaseKeyRotation(site));
        const second = requireSuccess(await startDatabaseKeyRotation(site));
        expect([first, second]).toEqual([START_MS, START_MS + 1]);
        clock.tick(60_000);
        expect((await completeDatabaseKeyRotation(site, first)).ok).toBe(false);
        expect((await completeDatabaseKeyRotation(site, second)).ok).toBe(
          false,
        );
        expect(issued.calls.length).toBe(0);
        clock.tick(1);
        expect(await completeDatabaseKeyRotation(site, second)).toEqual({
          ok: true,
        });
        expect(issued.calls.length).toBe(1);
      }));

    test("releases the claim when token creation throws", async () => {
      const failure = new Error("provider transport stopped");
      await withRotation(
        { issue: () => Promise.reject(failure) },
        async (site, { clock }) => {
          const started = requireSuccess(await startDatabaseKeyRotation(site));
          clock.tick(60_000);
          await expect(completeDatabaseKeyRotation(site, started)).rejects.toBe(
            failure,
          );
          const current = await requireBuiltSiteByIdPrimary(site.id);
          expect([current.databaseKeyRotationStarted, current.dbToken]).toEqual(
            [0, "old-key"],
          );
        },
      );
    });
  },
);
