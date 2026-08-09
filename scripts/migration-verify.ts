#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

/**
 * Read-only migration readiness verifier (an operator CLI).
 *
 * Reads the legacy payment tables, attendee PII blobs, and attendee-merge
 * references from the configured database — a live one, or one freshly
 * restored from an old backup into the current application — and reports
 * whether they are safe to migrate in a later fleet-wide release. Writes
 * nothing.
 *
 * Supply the owner username to verify the owner key can decrypt every attendee
 * PII blob and merge-reference charge; without it the verifier blocks on
 * encrypted attendee PII rather than skipping it.
 *
 *   deno task migration-verify                      # checks the payment tables only
 *   deno task migration-verify --owner <username>    # also verifies attendee PII decryption
 *
 * Reads DB_URL / DB_TOKEN / DB_ENCRYPTION_KEY from the environment; load them
 * with `--env-file=.env` or export them first.
 */

import { load } from "@std/dotenv";
import {
  createMigrationVerifyOwnerKey,
  createMigrationVerifyReader,
} from "#scripts/migration-verify-deps.ts";
import { runMigrationVerifyCli } from "#scripts/migration-verify-lib.ts";
import { runDenoScript, type ScriptIo } from "#scripts/script-runner.ts";
import { readDatabaseConfigOrError } from "#shared/db/database-config.ts";

const fileEnv = await load();
for (const [key, value] of Object.entries(fileEnv)) {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
}

const DEFAULT_VERIFY_PAGE_SIZE = 500;
const EXIT_USAGE = 2;

await runDenoScript(async (io: ScriptIo) => {
  const config = readDatabaseConfigOrError(io.getEnv, "verify");
  if (!config.ok) {
    io.stderr(config.message);
    return EXIT_USAGE;
  }
  return runMigrationVerifyCli({
    ...io,
    ownerKey: createMigrationVerifyOwnerKey(),
    pageSize: DEFAULT_VERIFY_PAGE_SIZE,
    prompt: (message: string) => prompt(message),
    reader: createMigrationVerifyReader(DEFAULT_VERIFY_PAGE_SIZE),
  });
});
