#!/usr/bin/env -S deno run --env-file --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

/**
 * Rotate one built site's database key from the command line.
 *
 * The database's provider removes every key it issued for that database. The
 * provider needs a short downtime to finish the removal, so this script waits
 * one minute. It then makes one new key, stores it on the built site record,
 * and sends it to the site as DB_TOKEN, so the site keeps reading its
 * database.
 *
 * Reads the host's settings from `.env`: the host database (DB_URL, DB_TOKEN,
 * DB_ENCRYPTION_KEY), the database provider's key (TURSO_API_TOKEN and
 * TURSO_ORGANIZATION, or BUNNY_API_KEY), and the hosting provider's key
 * (BUNNY_API_KEY or DENO_DEPLOY_TOKEN).
 *
 *   deno task rotate:db-key
 */

import { builtSites } from "#db/built-sites.ts";
import { runRotateDatabaseKeyCli } from "#scripts/rotate-database-key/run.ts";
import { runDenoScript } from "#scripts/script-runner.ts";
import {
  completeDatabaseKeyRotation,
  startDatabaseKeyRotation,
} from "#shared/database-key-rotation.ts";
import { delay } from "#shared/now.ts";

await runDenoScript((io) =>
  runRotateDatabaseKeyCli({
    ...io,
    completeRotation: completeDatabaseKeyRotation,
    listSites: () => builtSites.getAll(),
    prompt,
    startRotation: startDatabaseKeyRotation,
    wait: (seconds) => delay(seconds * 1000),
  }),
);
