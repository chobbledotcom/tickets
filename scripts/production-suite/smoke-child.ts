/**
 * Child for the production-suite edge-bundle smoke: prepares a migrated,
 * setup-complete SQLite database through the app's own node-side client,
 * then exposes it to the freshly imported edge bundle over HTTP. The bundle
 * resolves @libsql/client to its web build, which cannot open `file:` URLs,
 * so the child bridges the bundle's Hrana-over-HTTP wire requests to the
 * local database with the shared test bridge (hranaTestFetch) installed as
 * the bundle's fetch before the import. It then serves /robots.txt through
 * the bundle's handler and prints one JSON line.
 */

import { setFastPbkdf2ForTest } from "#crypto/hashing.ts";
import { setRsaKeySizeForTest } from "#crypto/hybrid.ts";
import { bootBundle } from "#scripts/bench/cold-start/boot-bundle.ts";
import { prepareBootDatabase } from "#scripts/bench/cold-start/prepare-db.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { hranaTestFetch } from "#test-utils/hrana.ts";

const [target] = Deno.args;
if (!target) {
  console.error("usage: smoke-child.ts <bundle-path>");
  Deno.exit(1);
}
// The bundle reads DB_URL itself and its web client rejects `file:` URLs, so
// it gets the bridge's HTTP URL while the child reads the real database file
// from SMOKE_DB_FILE.
const dbUrl = Deno.env.get("DB_URL");
const dbFile = Deno.env.get("SMOKE_DB_FILE");
if (!dbUrl || !dbFile) {
  throw new Error(
    "DB_URL and SMOKE_DB_FILE environment variables are required",
  );
}

// Weaker prep-only crypto; the smoke never logs in.
setFastPbkdf2ForTest(true);
setRsaKeySizeForTest(1024);
setSuppressDebugLogs(true);

const db = await prepareBootDatabase(
  `file:${dbFile}`,
  "smokeadmin",
  "smoke-password-123",
);

// Bridge the bundle's database requests (aimed at the DB_URL host) to the
// local database; everything else fetches for real.
const DB_HOST = new URL(dbUrl).host;
const bridge = hranaTestFetch((sql, args) => db.execute({ args, sql }));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (new URL(request.url).host === DB_HOST) return bridge.fetch(request);
  return realFetch(request);
};

const timings = await bootBundle(target, "request", (response, body) =>
  response.status !== 200
    ? `first request failed with status ${response.status}`
    : body.startsWith("User-agent:")
      ? null
      : "first request did not return a robots.txt body",
);
console.log(JSON.stringify(timings));
