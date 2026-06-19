/**
 * Generic read access to a built site's own database.
 *
 * For every site we build we keep its libsql URL and a **read-only** auth token
 * (never its DB_ENCRYPTION_KEY). That is enough to read the site's unencrypted
 * rows — e.g. plaintext `settings` markers — without ever being able to decrypt
 * its private data. This module is the single, reusable place that opens such a
 * connection; callers pass a small read function and get a tagged result back.
 *
 * Only plaintext columns are meaningful here: anything stored encrypted on the
 * site (see ENCRYPTED_KEYS in settings.ts) is unreadable without the per-site
 * key we deliberately never hold.
 */

import { type Client, createClient } from "@libsql/client";
import type { BuiltSite } from "#shared/db/built-sites.ts";

/** Credentials needed to open a read-only connection to a site's database. */
export type SiteDbCredentials = Pick<BuiltSite, "dbUrl" | "dbToken">;

/** Result of a read against a site database. */
export type SiteDbResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Stubbable client factory so tests can inject an in-memory database. */
export const siteDbApi = {
  createClient: (url: string, authToken: string): Client =>
    createClient(authToken ? { authToken, url } : { url }),
};

/** Do we hold both a URL and a read-only token for this site's database? */
export const hasSiteDbCredentials = (creds: SiteDbCredentials): boolean =>
  Boolean(creds.dbUrl && creds.dbToken);

/**
 * Open a connection to a site's database with its read-only keys, run `fn`, and
 * always close the connection. Connection/query errors are caught and returned
 * as `{ ok: false }` rather than thrown, so a parent host stays up even when a
 * child site's database is unreachable.
 */
export const withSiteDb = async <T>(
  creds: SiteDbCredentials,
  fn: (client: Client) => Promise<T>,
): Promise<SiteDbResult<T>> => {
  if (!creds.dbUrl)
    return { error: "No database URL for this site", ok: false };
  // Close on both the success and failure paths rather than in a `finally`:
  // the catch always returns (never rethrows), so a `finally` would carry an
  // exception-in-flight branch that can never be taken. `client` is undefined
  // only when opening the connection itself threw, hence the optional close.
  let client: Client | undefined;
  try {
    client = siteDbApi.createClient(creds.dbUrl, creds.dbToken);
    const value = await fn(client);
    client.close();
    return { ok: true, value };
  } catch (e) {
    client?.close();
    return { error: (e as Error).message, ok: false };
  }
};

/**
 * Read a single plaintext value from a site's `settings` table. Resolves to
 * `null` when the key is absent, or `{ ok: false }` when the database can't be
 * reached. Encrypted settings come back as ciphertext and are not useful here.
 */
export const readSiteSetting = (
  creds: SiteDbCredentials,
  key: string,
): Promise<SiteDbResult<string | null>> =>
  withSiteDb(creds, async (client) => {
    const result = await client.execute({
      args: [key],
      sql: "SELECT value FROM settings WHERE key = ?",
    });
    const row = result.rows[0];
    return row ? (row.value as string) : null;
  });
