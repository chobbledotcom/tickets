/** Direct tests for database-key-rotation.ts: which sites this host can change
 *  the key of, and what each of the two steps does. The signed links that
 *  finish a rotation have their own file beside this one. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import {
  findBuiltSiteByIdPrimary,
  insertBuiltSite,
  requireBuiltSiteByIdPrimary,
  updateBuiltSite,
} from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import {
  completeDatabaseKeyRotation,
  databaseKeyRotationAccess,
  startDatabaseKeyRotation,
} from "#shared/database-key-rotation.ts";
import { errorResult, type Outcome, okResult } from "#shared/result.ts";
import { tursoDbProvider } from "#shared/turso-api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";

const BUNNY_DB_URL = "libsql://site-key.lite.bunnydb.net";
const TURSO_DB_URL = "libsql://site-key-org.turso.io";

const HOST_SETTINGS = {
  BUNNY_API_KEY: "bunny-key",
  TURSO_API_TOKEN: "turso-key",
  TURSO_ORGANIZATION: "org",
};

const DB_URLS = {
  bunny: BUNNY_DB_URL,
  local: "file:local.db",
  none: "",
  other: "libsql://db.example.com",
  turso: TURSO_DB_URL,
};

/** The fixed clock shared by the provider-step tests. */
const START_MS = 1_700_000_000_000;

/** A blank answer is a success. Any other text is the error. */
const outcomeOf = (error: string) =>
  error ? errorResult(error) : { ok: true as const };

/** Stand in for the provider calls one test makes: each answers its own error,
 * and otherwise removes the keys or makes "new-key". */
const stubProviderCalls = (
  provider: typeof bunnyDbProvider,
  answers: { invalidate?: string; issue?: string },
) => {
  const invalidate = stub(provider, "invalidateDatabaseTokens", () =>
    Promise.resolve(
      answers.invalidate
        ? errorResult(answers.invalidate)
        : okResult(undefined),
    ),
  );
  const issue = stub(provider, "issueDatabaseToken", () =>
    Promise.resolve(
      answers.issue ? errorResult(answers.issue) : okResult("new-key"),
    ),
  );
  return {
    [Symbol.dispose]: () => {
      invalidate.restore();
      issue.restore();
    },
    invalidate,
    issue,
  };
};

/** Stand in for the secret push, and keep every value it sent. */
const stubSecretPush = (error = "") => {
  const pushes: unknown[][] = [];
  const push = stub(bunnyCdnApi, "setEdgeScriptSecret", (...sent) => {
    pushes.push(sent);
    return Promise.resolve(outcomeOf(error));
  });
  return {
    [Symbol.dispose]: () => push.restore(),
    pushes,
  };
};

/** One site whose database key the host manages. */
const keySite = async (dbUrl = BUNNY_DB_URL): Promise<number> =>
  (
    await insertBuiltSite(
      "Key Site",
      "https://key.test",
      dbUrl,
      "old-key",
      false,
      "9100",
    )
  ).id;

/** The second the site's rotation began, or 0 when none waits. */
const claimOf = async (id: number): Promise<number> =>
  (await findBuiltSiteByIdPrimary(id))!.databaseKeyRotationStarted;

/** The key the site record holds now. */
const storedKeyOf = async (id: number): Promise<string> =>
  (await findBuiltSiteByIdPrimary(id))!.dbToken;

/* jscpd:ignore-start -- a list of strings, not code */
/** Each refusal: the database, the hosting ID, the host settings that are
 * absent (comma-joined), and the message the admin reads. */
const ACCESS_REFUSALS: [
  name: string,
  database: keyof typeof DB_URLS,
  hostingId: string,
  unset: string,
  error: string,
][] = [
  [
    "refuses a site with no database address",
    "none",
    "9",
    "",
    "This site has no database address, so its key cannot be changed.",
  ],
  [
    "refuses a local database file",
    "local",
    "9",
    "",
    "This site's database is a local file, so its key cannot be changed.",
  ],
  [
    "refuses an address the host does not manage",
    "other",
    "9",
    "",
    "The host does not manage this site's database, so it cannot change its key.",
  ],
  [
    "names the Bunny setting a Bunny rotation needs",
    "bunny",
    "9",
    "BUNNY_API_KEY",
    "This host cannot change a Bunny database key. Set BUNNY_API_KEY on the host first.",
  ],
  [
    "names both settings a Turso rotation needs",
    "turso",
    "9",
    "TURSO_API_TOKEN,TURSO_ORGANIZATION",
    "This host cannot change a Turso database key. Set TURSO_API_TOKEN and TURSO_ORGANIZATION on the host first.",
  ],
  [
    "refuses a site with no hosting ID, because the key cannot reach it",
    "bunny",
    "",
    "",
    "This site has no hosting ID, so its database key can't be sent to it.",
  ],
];
/* jscpd:ignore-end */

describeWithEnv("database key rotation access", { env: HOST_SETTINGS }, () => {
  for (const [name, database, hostingId, unset, error] of ACCESS_REFUSALS) {
    test(name, () => {
      using _env = withEnv(
        Object.fromEntries(
          unset
            .split(",")
            .filter(Boolean)
            .map((key): [string, undefined] => [key, undefined]),
        ),
      );
      expect(
        databaseKeyRotationAccess(
          testBuiltSite({ dbUrl: DB_URLS[database], hostingId }),
        ),
      ).toEqual({ error, ok: false });
    });
  }

  test("names the provider a reachable site rotates on", () => {
    expect(
      databaseKeyRotationAccess(
        testBuiltSite({ dbUrl: TURSO_DB_URL, hostingId: "9" }),
      ),
    ).toEqual({ hostingId: "9", ok: true, provider: "turso" });
  });
});

/* jscpd:ignore-start -- a list of strings, not code */
/** Each refused start: the site's database, the error the provider answers, the
 * message the caller reads, and the provider calls it made. */
const START_REFUSALS: [
  name: string,
  dbUrl: string,
  invalidate: string,
  error: string,
  calls: string,
][] = [
  [
    "records no pause when the provider refuses the key removal",
    BUNNY_DB_URL,
    "Revoke database tokens failed (500)",
    "Revoke database tokens failed (500)",
    "1",
  ],
  [
    "refuses a database this host does not manage, and reaches no provider",
    "file:local.db",
    "",
    "This site's database is a local file, so its key cannot be changed.",
    "0",
  ],
];
/* jscpd:ignore-end */

describeWithEnv("database key start", { db: true, env: HOST_SETTINGS }, () => {
  test("removes every old key, records the pause, and stores no key", async () => {
    using _time = new FakeTime(START_MS);
    const site = (await findBuiltSiteByIdPrimary(await keySite()))!;
    using calls = stubProviderCalls(bunnyDbProvider, {});

    expect(await startDatabaseKeyRotation(site)).toEqual({
      ok: true,
      value: START_MS,
    });
    expect(calls.invalidate.calls.map((call) => call.args[0])).toEqual([
      BUNNY_DB_URL,
    ]);
    expect(calls.issue.calls.length).toBe(0);
    expect(await storedKeyOf(site.id)).toBe("old-key");
    expect(await claimOf(site.id)).toBe(START_MS);
  });

  test("replaces the start a rotation was already waiting on", async () => {
    using time = new FakeTime(START_MS);
    const site = (await findBuiltSiteByIdPrimary(await keySite()))!;
    using _calls = stubProviderCalls(bunnyDbProvider, {});

    await startDatabaseKeyRotation(site);
    time.tick(30_000);
    expect(await startDatabaseKeyRotation(site)).toEqual({
      ok: true,
      value: START_MS + 30_000,
    });
    expect(await claimOf(site.id)).toBe(START_MS + 30_000);
  });

  for (const [name, dbUrl, invalidate, error, calls] of START_REFUSALS) {
    test(name, async () => {
      const site = (await findBuiltSiteByIdPrimary(await keySite(dbUrl)))!;
      using provider = stubProviderCalls(bunnyDbProvider, { invalidate });

      expect(await startDatabaseKeyRotation(site)).toEqual({
        error,
        ok: false,
      });
      expect(provider.invalidate.calls.length).toBe(Number(calls));
      expect(await claimOf(site.id)).toBe(0);
      expect(await storedKeyOf(site.id)).toBe("old-key");
    });
  }
});

/** Start a rotation on the test clock and return its timestamp. */
const startedClaim = async (site: number): Promise<number> => {
  const result = await startDatabaseKeyRotation(
    await requireBuiltSiteByIdPrimary(site),
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

/** The fakes one completion test needs, live until the test ends. */
interface WaitingRotation extends Disposable {
  calls: ReturnType<typeof stubProviderCalls>;
  id: number;
  pushes: unknown[][];
  started: number;
}

/** One site whose rotation waits, with the provider calls and the secret push
 * faked. A step a test leaves out answers success. */
const waitingRotation = async (
  answers: { invalidate?: string; issue?: string; push?: string } = {},
  dbUrl = BUNNY_DB_URL,
): Promise<WaitingRotation> => {
  const id = await keySite(dbUrl);
  const provider = dbUrl === TURSO_DB_URL ? tursoDbProvider : bunnyDbProvider;
  const calls = stubProviderCalls(provider, answers);
  const push = stubSecretPush(answers.push);
  const started = await startedClaim(id);
  return {
    [Symbol.dispose]: () => {
      push[Symbol.dispose]();
      calls[Symbol.dispose]();
    },
    calls,
    id,
    pushes: push.pushes,
    started,
  };
};

/** Complete the rotation one waiting site holds, as its timer link does. */
const completeWaitingRotation = async (
  rotation: WaitingRotation,
): Promise<Outcome> =>
  completeDatabaseKeyRotation(
    await requireBuiltSiteByIdPrimary(rotation.id),
    rotation.started,
  );

/* jscpd:ignore-start -- a list of strings, not code */
/** Provider and push refusals preserve the true stored key. */
const COMPLETION_CASES: [
  name: string,
  dbUrl: string,
  issue: string,
  push: string,
  error: string,
  stored: string,
][] = [
  ["stores and sends the Bunny key", BUNNY_DB_URL, "", "", "", "new-key"],
  ["stores and sends the Turso key", TURSO_DB_URL, "", "", "", "new-key"],
  [
    "keeps the stored key when the provider refuses",
    BUNNY_DB_URL,
    "Rotate database key failed (500)",
    "",
    "Rotate database key failed (500)",
    "old-key",
  ],
  [
    "keeps the new key stored when its push fails",
    BUNNY_DB_URL,
    "",
    "Set secret DB_TOKEN failed (500)",
    "The database key changed, but the site did not receive it. Rotate the key again to retry. Set secret DB_TOKEN failed (500)",
    "new-key",
  ],
];
/* jscpd:ignore-end */

describeWithEnv(
  "database key completion",
  { db: true, env: HOST_SETTINGS },
  () => {
    for (const [name, dbUrl, issue, push, error, stored] of COMPLETION_CASES) {
      test(name, async () => {
        using clock = new FakeTime(START_MS);
        using rotation = await waitingRotation({ issue, push }, dbUrl);
        clock.tick(60_000);

        expect(await completeWaitingRotation(rotation)).toEqual(
          outcomeOf(error),
        );
        expect(rotation.calls.issue.calls.length).toBe(1);
        expect(rotation.pushes).toEqual(
          issue ? [] : [[9100, "DB_TOKEN", "new-key"]],
        );
        expect(await storedKeyOf(rotation.id)).toBe(stored);
        expect(await claimOf(rotation.id)).toBe(0);
      });
    }

    test("refuses an older start, and one it already used", async () => {
      using time = new FakeTime(START_MS);
      using rotation = await waitingRotation();
      time.tick(30_000);
      const newer = await startedClaim(rotation.id);

      expect(await completeWaitingRotation(rotation)).toEqual({
        error:
          "This rotation link is no longer valid. Start the rotation again.",
        ok: false,
      });
      expect(await claimOf(rotation.id)).toBe(newer);
      time.tick(60_000);

      expect(
        await completeDatabaseKeyRotation(
          await requireBuiltSiteByIdPrimary(rotation.id),
          newer,
        ),
      ).toEqual({ ok: true });
      expect(
        await completeDatabaseKeyRotation(
          await requireBuiltSiteByIdPrimary(rotation.id),
          newer,
        ),
      ).toEqual({
        error:
          "This rotation link is no longer valid. Start the rotation again.",
        ok: false,
      });
      expect(rotation.calls.issue.calls.length).toBe(1);
    });

    test("keeps the waiting start when this host cannot finish the rotation", async () => {
      const id = await keySite("file:local.db");
      await updateBuiltSite(id, () => ({
        databaseKeyRotationStarted: START_MS,
      }));
      using calls = stubProviderCalls(bunnyDbProvider, {});

      expect(
        await completeDatabaseKeyRotation(
          await requireBuiltSiteByIdPrimary(id),
          START_MS,
        ),
      ).toEqual({
        error:
          "This site's database is a local file, so its key cannot be changed.",
        ok: false,
      });
      expect(calls.issue.calls.length).toBe(0);
      expect(await claimOf(id)).toBe(START_MS);
    });
  },
);
