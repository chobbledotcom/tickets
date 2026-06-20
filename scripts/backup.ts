#!/usr/bin/env -S deno run --env-file --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

/**
 * Out-of-band database backup.
 *
 * Runs the same dump as the in-app Backups page and the automatic
 * pre-migration backup, but from a full Deno process instead of a Bunny edge
 * isolate — so it is not bound by the edge's per-request outbound-subrequest
 * budget and can dump arbitrarily large databases. (Reads are keyset-paginated
 * either way, so no single response trips libsqld's "Response is too large"
 * payload cap.)
 *
 * Reads DB_URL / DB_TOKEN and the storage settings from the environment; load
 * them with `--env-file` or export them first. By default the backup is
 * uploaded to the configured storage zone, exactly like the in-app backup, so
 * it also appears on the Backups page and lets the next migration skip its own
 * inline backup (a fresh stored backup satisfies the freshness check). Pass
 * `--out <path>` to write the .zip to a local file instead.
 *
 *   deno task backup                 # upload to the configured storage zone
 *   deno task backup --out dump.zip  # write a local .zip instead
 */

import { createAndUploadBackup, createBackupZip } from "#shared/db/backup.ts";

const outIndex = Deno.args.indexOf("--out");

if (outIndex === -1) {
  const filename = await createAndUploadBackup();
  console.log(`Backup uploaded to storage: ${filename}`);
} else {
  const path = Deno.args[outIndex + 1];
  if (!path) {
    console.error("Usage: deno task backup --out <path>");
    Deno.exit(1);
  }
  await Deno.writeFile(path, await createBackupZip());
  console.log(`Backup written to ${path}`);
}
