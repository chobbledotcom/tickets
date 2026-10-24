#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

/**
 * Read-only migration readiness verifier (an operator CLI).
 *
 * Reads the legacy payment tables, attendee PII blobs, and attendee-merge
 * references from the configured database and reports whether they are safe
 * to migrate in a later fleet-wide release. Writes nothing.
 *
 *   deno task migration-verify [--owner <username>] [--page-size <n>]
 *
 * Without `--owner` the verifier blocks on encrypted attendee PII instead of
 * skipping it. DB_URL / DB_TOKEN / DB_ENCRYPTION_KEY come from the
 * environment (`.env` is loaded first); a missing or invalid value fails the
 * first database or key use. The owner password is read without echo: from
 * `MIGRATION_VERIFY_PASSWORD`, from non-terminal stdin, or from the terminal
 * in raw mode.
 */

import { load } from "@std/dotenv";
import {
  createMigrationVerifyOwnerKey,
  createMigrationVerifyReader,
} from "#scripts/migration-verify-deps.ts";
import { runMigrationVerifyCli } from "#scripts/migration-verify-lib.ts";
import { runDenoScript, type ScriptIo } from "#scripts/script-runner.ts";

const fileEnv = await load();
for (const [key, value] of Object.entries(fileEnv)) {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
}

const DEFAULT_VERIFY_PAGE_SIZE = 500;

/** Read password bytes from stdin one byte at a time until Enter or end of
 *  input. Returns the decoded text without the newline, or null when the
 *  input ended before any byte, so the caller blocks on an empty read.
 *  `onByte` sees every byte before it is collected; the raw-mode reader
 *  catches Ctrl-C there. */
const readPasswordBytes = (onByte: (byte: number) => void): string | null => {
  const bytes: number[] = [];
  const buf = new Uint8Array(1);
  for (;;) {
    const n = Deno.stdin.readSync(buf);
    const byte = n === null || n === 0 ? undefined : buf[0];
    if (byte === undefined) {
      return bytes.length === 0
        ? null
        : new TextDecoder().decode(Uint8Array.from(bytes));
    }
    onByte(byte);
    if (byte === 13 || byte === 10) {
      return new TextDecoder().decode(Uint8Array.from(bytes));
    }
    bytes.push(byte);
  }
};

/** Leave raw mode and print the newline the hidden Enter did not echo. */
const restoreTerminal = (): void => {
  Deno.stdin.setRaw(false);
  Deno.stdout.writeSync(new TextEncoder().encode("\n"));
};

/** Read one line from non-terminal stdin (piped input never echoes). */
const readPasswordLineFromStdin = (): string | null =>
  readPasswordBytes(() => {});

/** Read the owner password from the interactive terminal without echo: raw
 *  mode collects bytes until Enter. Ctrl-C restores the terminal and exits
 *  with code 130. */
const readPasswordLineFromTerminal = (message: string): string | null => {
  Deno.stdout.writeSync(new TextEncoder().encode(message));
  Deno.stdin.setRaw(true);
  try {
    const password = readPasswordBytes((byte) => {
      if (byte !== 3) return;
      restoreTerminal();
      Deno.exit(130);
    });
    restoreTerminal();
    return password;
  } catch (error) {
    Deno.stdin.setRaw(false);
    throw error;
  }
};

/** Read the owner password without echoing: the env var, a non-terminal stdin,
 *  or the raw-mode terminal reader. Returns null on EOF so the caller blocks. */
const readOwnerPassword = (message: string): string | null => {
  const fromEnv = Deno.env.get("MIGRATION_VERIFY_PASSWORD");
  if (fromEnv !== undefined) return fromEnv;
  return Deno.stdin.isTerminal()
    ? readPasswordLineFromTerminal(message)
    : readPasswordLineFromStdin();
};

await runDenoScript((io: ScriptIo) =>
  runMigrationVerifyCli({
    ...io,
    createReader: (pageSize) => createMigrationVerifyReader(pageSize),
    ownerKey: createMigrationVerifyOwnerKey(),
    pageSize: DEFAULT_VERIFY_PAGE_SIZE,
    prompt: readOwnerPassword,
  }),
);
