/** Direct tests for database-key-rotation.ts: which sites this host can change
 *  the key of, what each of the two steps does, and which rotation links it
 *  opens. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { findBuiltSiteByIdPrimary, insertBuiltSite } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import {
  DATABASE_KEY_PAUSE_SECONDS,
  databaseKeyIssueAllowed,
  databaseKeyIssueUrl,
  databaseKeyRotationAccess,
  invalidateDatabaseKey,
  issueDatabaseKey,
} from "#shared/database-key-rotation.ts";
import type { DatabaseProviderApi } from "#shared/provider-types.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { tursoDbProvider } from "#shared/turso-api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";

const BUNNY_DB_URL = "libsql://site-key.lite.bunnydb.net";
const TURSO_DB_URL = "libsql://site-key-org.turso.io";

const HOST_SETTINGS = {
  BUNNY_API_KEY: "bunny-key",
  TURSO_API_TOKEN: "turso-key",
  TURSO_ORGANIZATION: "org",
};

const PROVIDERS = { bunny: bunnyDbProvider, turso: tursoDbProvider };
const DB_URLS = {
  bunny: BUNNY_DB_URL,
  local: "file:local.db",
  none: "",
  other: "libsql://db.example.com",
  turso: TURSO_DB_URL,
};

/** A blank answer is a success. Any other text is the error. */
const outcomeOf = (error: string) =>
  error ? errorResult(error) : { ok: true as const };

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

/** The two steps of a rotation. */
const STEPS = {
  invalidate: invalidateDatabaseKey,
  issue: issueDatabaseKey,
} as const;

/** Stand in for one provider step: a blank error answers the key the host
 * stores, and any other text is the provider's refusal. */
const stubStep = (
  provider: DatabaseProviderApi,
  step: keyof typeof STEPS,
  error: string,
) =>
  step === "invalidate"
    ? stub(provider, "invalidateDatabaseTokens", () =>
        Promise.resolve(error ? errorResult(error) : okResult(undefined)),
      )
    : stub(provider, "issueDatabaseToken", () =>
        Promise.resolve(error ? errorResult(error) : okResult("new-key")),
      );

/* jscpd:ignore-start -- a list of strings, not code */
/** Each step: which one runs, the site's database, the provider, the error the
 * provider answers, the error the site's secret store answers, the error the
 * caller reads, and the key the site record holds afterwards. A blank error is
 * a success. */
const STEPS_UNDER_TEST: [
  name: string,
  step: keyof typeof STEPS,
  database: keyof typeof DB_URLS,
  provider: keyof typeof PROVIDERS,
  providerError: string,
  pushError: string,
  outcomeError: string,
  stored: string,
][] = [
  [
    "removes every old Bunny key and stores nothing",
    "invalidate",
    "bunny",
    "bunny",
    "",
    "",
    "",
    "old-key",
  ],
  [
    "removes every old Turso key and stores nothing",
    "invalidate",
    "turso",
    "turso",
    "",
    "",
    "",
    "old-key",
  ],
  [
    "reports a refused key removal and keeps the stored key",
    "invalidate",
    "bunny",
    "bunny",
    "Revoke database tokens failed (500)",
    "",
    "Revoke database tokens failed (500)",
    "old-key",
  ],
  [
    "refuses a database this host does not manage",
    "invalidate",
    "local",
    "bunny",
    "",
    "",
    "This site's database is a local file, so its key cannot be changed.",
    "old-key",
  ],
  [
    "stores the new Bunny key and sends it to the site",
    "issue",
    "bunny",
    "bunny",
    "",
    "",
    "",
    "new-key",
  ],
  [
    "stores the new Turso key and sends it to the site",
    "issue",
    "turso",
    "turso",
    "",
    "",
    "",
    "new-key",
  ],
  [
    "leaves the stored key alone when the provider refuses a new key",
    "issue",
    "bunny",
    "bunny",
    "Rotate database key failed (500)",
    "",
    "Rotate database key failed (500)",
    "old-key",
  ],
  [
    "keeps the new key stored when the push fails, so a retry can finish",
    "issue",
    "bunny",
    "bunny",
    "",
    "Set secret DB_TOKEN failed (500)",
    "The database key changed, but the site did not receive it. Rotate the key again to retry. Set secret DB_TOKEN failed (500)",
    "new-key",
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

describeWithEnv("database key steps", { db: true, env: HOST_SETTINGS }, () => {
  for (const [
    name,
    step,
    database,
    provider,
    providerError,
    pushError,
    outcomeError,
    stored,
  ] of STEPS_UNDER_TEST) {
    test(name, async () => {
      const { id } = await insertBuiltSite(
        "Key Site",
        "https://key.test",
        DB_URLS[database],
        "old-key",
        false,
        "9100",
      );
      const pushed: unknown[][] = [];
      using stepStub = stubStep(PROVIDERS[provider], step, providerError);
      using _push = stub(bunnyCdnApi, "setEdgeScriptSecret", (...sent) => {
        pushed.push(sent);
        return Promise.resolve(outcomeOf(pushError));
      });

      const site = (await findBuiltSiteByIdPrimary(id))!;
      expect(await STEPS[step](site)).toEqual(outcomeOf(outcomeError));
      // A refused site never reaches the provider.
      expect(stepStub.calls.length).toBe(database === "local" ? 0 : 1);
      const issued = step === "issue" && !providerError;
      expect(pushed).toEqual(issued ? [[9100, "DB_TOKEN", "new-key"]] : []);
      expect((await findBuiltSiteByIdPrimary(id))!.dbToken).toBe(stored);
    });
  }
});

/** Seconds a rotation link stays open. */
const LINK_SECONDS = 600;

/** The pause a link waits out before it opens. */
const PAUSE_MS = DATABASE_KEY_PAUSE_SECONDS * 1000;

/** The clock every link test signs on. */
const START_MS = 1_700_000_000_000;

describe("database key rotation links", () => {
  let fakeTime: FakeTime;

  beforeEach(() => {
    setupTestEncryptionKey();
    fakeTime = new FakeTime(START_MS);
  });

  afterEach(() => fakeTime.restore());

  const signedLink = async (
    siteId = 7,
  ): Promise<{ exp: string | null; sig: string | null }> => {
    const params = new URL(`http://x${await databaseKeyIssueUrl(siteId)}`)
      .searchParams;
    return { exp: params.get("exp"), sig: params.get("sig") };
  };

  test("signs the site's own completion route for ten minutes", async () => {
    const url = await databaseKeyIssueUrl(7);
    expect(
      url.startsWith("/admin/built-sites/7/rotate-database-key/complete?exp="),
    ).toBe(true);
    const expiry = Number.parseInt(
      new URL(`http://x${url}`).searchParams.get("exp") ?? "",
      10,
    );
    expect(expiry - Math.floor(START_MS / 1000)).toBe(LINK_SECONDS);
  });

  test("opens a link for its own site once the pause has passed", async () => {
    const { exp, sig } = await signedLink(7);
    fakeTime.tick(PAUSE_MS);
    expect(await databaseKeyIssueAllowed(7, exp, sig)).toBe(true);
    expect(await databaseKeyIssueAllowed(8, exp, sig)).toBe(false);
  });

  test("refuses a link opened before the pause ends", async () => {
    const link = await signedLink(7);
    fakeTime.tick(PAUSE_MS - 1000);
    expect(await databaseKeyIssueAllowed(7, link.exp, link.sig)).toBe(false);
    fakeTime.tick(1000);
    expect(await databaseKeyIssueAllowed(7, link.exp, link.sig)).toBe(true);
  });

  test("refuses a link after ten minutes", async () => {
    const link = await signedLink(7);
    fakeTime.tick((LINK_SECONDS + 1) * 1000);
    expect(await databaseKeyIssueAllowed(7, link.exp, link.sig)).toBe(false);
  });

  test("refuses a link with no expiry or no signature", async () => {
    const { exp, sig } = await signedLink(7);
    expect(await databaseKeyIssueAllowed(7, null, sig)).toBe(false);
    expect(await databaseKeyIssueAllowed(7, exp, null)).toBe(false);
  });

  test("refuses an altered link", async () => {
    const { exp, sig } = await signedLink(7);
    const farFuture = String(Math.floor(START_MS / 1000) + LINK_SECONDS + 61);
    expect(await databaseKeyIssueAllowed(7, farFuture, sig)).toBe(false);
    expect(await databaseKeyIssueAllowed(7, "notanumber", sig)).toBe(false);
    expect(await databaseKeyIssueAllowed(7, exp, `${sig ?? ""}XXXX`)).toBe(
      false,
    );
  });
});
