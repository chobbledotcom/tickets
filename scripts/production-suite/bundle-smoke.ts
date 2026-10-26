/**
 * Edge-bundle smoke for the production suite: build the edge bundle through
 * the same production pipeline `deno task build:edge` uses (shared
 * `buildServeAppBundle`, `src/serve-app.ts` entry, client build included),
 * then boot it in a fresh Deno process and prove it serves — not just that
 * the file exists. The boot child (smoke-child.ts) gives the bundle a real
 * migrated database over HTTP and serves /robots.txt through the bundle's
 * handler, failing on a non-200 response or a non-robots body: the real-boot
 * check a smoke needs, without a second implementation of the
 * bundle-serving contract.
 */

import { spawnChildJson } from "../bench/cold-start/spawn-child.ts";
import { buildServeAppBundle } from "../edge-bundle-lib.ts";

const OUT_DIR = "./dist/production-suite";
const BUNDLE = `${OUT_DIR}/serve-app.js`;

/** A boot that serves, with a timeout so a hung boot fails loudly. */
const BOOT_TIMEOUT_MS = 120_000;

// The app refuses to boot without a database encryption key (file databases
// are encrypted), so the child gets the same CI value test.yml exports.
const DB_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

type ChildTimings = {
  importMs: number;
  firstRequestMs: number;
};

export const runBundleSmoke = async (): Promise<void> => {
  await buildServeAppBundle(BUNDLE, "Smoke");

  const dbFile = await Deno.makeTempFile({
    prefix: "production-suite-smoke-",
    suffix: ".db",
  });
  const timings = await spawnChildJson<ChildTimings>(
    [
      "run",
      "--quiet",
      "--no-check",
      "--allow-read",
      "--allow-env",
      "--allow-write",
      "--allow-net",
      "--allow-sys",
      "--allow-ffi",
      "scripts/production-suite/smoke-child.ts",
      BUNDLE,
    ],
    {
      DB_ENCRYPTION_KEY,
      DB_URL: "http://smoke-db.invalid/",
      SMOKE_DB_FILE: dbFile,
    },
    BOOT_TIMEOUT_MS,
    "edge-bundle smoke boot",
  );

  console.log(
    "edge bundle booted and served /robots.txt " +
      `(import ${timings.importMs.toFixed(0)}ms, ` +
      `first request ${timings.firstRequestMs.toFixed(0)}ms)`,
  );
};
