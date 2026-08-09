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
 *
 * The owner password is read from stdin when it is not a terminal (so piping
 * or redirecting never echoes it). On an interactive terminal `prompt()` is
 * used, which echoes — pass the password via stdin (`printf 'pw\n' | deno task
 * migration-verify --owner …`) or the `MIGRATION_VERIFY_PASSWORD` env var when
 * echo must be avoided.
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

/** Read one line from a non-terminal stdin (piped input never echoes). Returns
 *  null on EOF before any input, else the text up to the first newline. */
const readPasswordLineFromStdin = (): string | null => {
  const buf = new Uint8Array(1024);
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const n = Deno.stdin.readSync(buf);
    if (n === null) return text === "" ? null : text;
    text += decoder.decode(buf.subarray(0, n));
    if (text.includes("\n")) return text.slice(0, text.indexOf("\n"));
    if (n === 0) return text === "" ? null : text;
  }
};

/** Read the owner password without echoing. On a non-terminal stdin the line
 *  is read directly (no echo). On an interactive terminal it falls back to
 *  Deno's `prompt()`, which echoes — operators who need no echo pipe stdin or
 *  set `MIGRATION_VERIFY_PASSWORD`. Returns null on EOF so the caller blocks. */
const readOwnerPassword = (message: string): string | null => {
  const fromEnv = Deno.env.get("MIGRATION_VERIFY_PASSWORD");
  if (fromEnv !== undefined) return fromEnv;
  return Deno.stdin.isTerminal()
    ? prompt(message)
    : readPasswordLineFromStdin();
};

await runDenoScript(async (io: ScriptIo) => {
  const config = readDatabaseConfigOrError(io.getEnv, "verify");
  if (!config.ok) {
    io.stderr(config.message);
    return EXIT_USAGE;
  }
  return runMigrationVerifyCli({
    ...io,
    createReader: (pageSize) => createMigrationVerifyReader(pageSize),
    ownerKey: createMigrationVerifyOwnerKey(),
    pageSize: DEFAULT_VERIFY_PAGE_SIZE,
    prompt: readOwnerPassword,
  });
});
