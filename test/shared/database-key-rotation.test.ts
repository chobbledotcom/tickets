/** Direct tests for database-key-rotation.ts: which sites this host can rotate
 *  the key of, and what the rotation checks before it stores and pushes one. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { findBuiltSiteByIdPrimary, insertBuiltSite } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import {
  databaseKeyRotationAccess,
  rotateDatabaseKey,
} from "#shared/database-key-rotation.ts";
import { errorResult, okResult } from "#shared/result.ts";
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

/** Each rotation: the provider, the error the provider answers, the error the
 * site's secret store answers, the error the caller reads, and the key the
 * site record holds afterwards. A blank error is a success. */
const ROTATIONS: [
  name: string,
  provider: keyof typeof PROVIDERS,
  rotateError: string,
  pushError: string,
  outcomeError: string,
  stored: string,
][] = [
  [
    "stores the new Bunny key and sends it to the site",
    "bunny",
    "",
    "",
    "",
    "new-key",
  ],
  [
    "stores the new Turso key and sends it to the site",
    "turso",
    "",
    "",
    "",
    "new-key",
  ],
  [
    "leaves the stored key alone when the provider refuses",
    "bunny",
    "Revoke database tokens failed (500)",
    "",
    "Revoke database tokens failed (500)",
    "old-key",
  ],
  [
    "keeps the new key stored when the push fails, so a retry can finish",
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

describeWithEnv("rotateDatabaseKey", { db: true, env: HOST_SETTINGS }, () => {
  for (const [
    name,
    provider,
    rotateError,
    pushError,
    outcomeError,
    stored,
  ] of ROTATIONS) {
    test(name, async () => {
      const { id } = await insertBuiltSite(
        "Key Site",
        "https://key.test",
        DB_URLS[provider],
        "old-key",
        false,
        "9100",
      );
      const pushed: unknown[][] = [];
      using _rotate = stub(PROVIDERS[provider], "rotateDatabaseKey", () =>
        Promise.resolve(
          rotateError ? errorResult(rotateError) : okResult("new-key"),
        ),
      );
      using _push = stub(bunnyCdnApi, "setEdgeScriptSecret", (...sent) => {
        pushed.push(sent);
        return Promise.resolve(outcomeOf(pushError));
      });

      const site = (await findBuiltSiteByIdPrimary(id))!;
      expect(await rotateDatabaseKey(site)).toEqual(outcomeOf(outcomeError));
      expect(pushed).toEqual(
        rotateError ? [] : [[9100, "DB_TOKEN", "new-key"]],
      );
      expect((await findBuiltSiteByIdPrimary(id))!.dbToken).toBe(stored);
    });
  }
});
