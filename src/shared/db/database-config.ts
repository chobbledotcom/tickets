/**
 * Shared database-connection validation for operator CLIs (restore, verify).
 *
 * Both `deno task restore` and `deno task migration-verify` need the same DB
 * credentials from `.env` — `DB_URL`, the `DB_TOKEN` a remote database
 * requires, and a `DB_ENCRYPTION_KEY` that decodes to 32 bytes. Rather than
 * duplicate the guards in each CLI, they share this one check so the messages
 * and the `:memory:` refusal stay identical.
 */

import { decodeKeyBytes } from "#shared/crypto/encryption.ts";
import { errorMessage } from "#shared/error-message.ts";

const REMOTE_DB_URL_PREFIXES = ["https://", "libsql://"];

export type DatabaseConfigNoun = "restore" | "verify";

/** Validate the database connection env. Returns the `DB_URL` when every
 *  requirement holds, otherwise an error message naming the first missing or
 *  invalid value. `noun` is used in the `:memory:` refusal so each CLI names
 *  the action it refused. */
export const readDatabaseConfigOrError = (
  getEnv: (key: string) => string | undefined,
  noun: DatabaseConfigNoun,
): { ok: true; dbUrl: string } | { ok: false; message: string } => {
  const dbUrl = getEnv("DB_URL");
  if (!dbUrl?.trim()) {
    return { message: "DB_URL is required in .env.", ok: false };
  }
  if (dbUrl === ":memory:") {
    return {
      message: `DB_URL cannot be :memory: for a ${noun}. Set it to the target database in .env.`,
      ok: false,
    };
  }
  if (
    REMOTE_DB_URL_PREFIXES.some((prefix) => dbUrl.startsWith(prefix)) &&
    !getEnv("DB_TOKEN")?.trim()
  ) {
    return {
      message: "DB_TOKEN is required in .env for a remote database.",
      ok: false,
    };
  }
  const encryptionKey = getEnv("DB_ENCRYPTION_KEY");
  if (!encryptionKey?.trim()) {
    return { message: "DB_ENCRYPTION_KEY is required in .env.", ok: false };
  }
  try {
    decodeKeyBytes(encryptionKey);
  } catch (error) {
    return { message: errorMessage(error), ok: false };
  }
  return { dbUrl, ok: true };
};
