/**
 * Marketing email unsubscribe list.
 *
 * Stores only the HMAC of each opted-out address (see `hashEmail`), never the
 * address itself — the same blind-index approach used for ticket tokens and
 * usernames. Unsubscribe/resubscribe links carry this hash, so the recipient
 * can opt out (or back in) without the address ever appearing in a URL or in
 * this table. Presence of a row means "unsubscribed".
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import { deleteByField, getDb, queryAll, queryOne } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";

/**
 * Compute the stored hash for an email address. Trimmed and lower-cased first
 * so "Bob@Example.com" and "bob@example.com " resolve to the same opt-out.
 */
export const hashEmail = (email: string): Promise<string> =>
  hmacHash(email.trim().toLowerCase());

/** Whether a given email hash is currently on the unsubscribe list. */
export const isHashUnsubscribed = async (hash: string): Promise<boolean> => {
  const row = await queryOne<{ email_hash: string }>(
    "SELECT email_hash FROM unsubscribed_emails WHERE email_hash = ?",
    [hash],
  );
  return row !== null;
};

/** Add an email hash to the unsubscribe list (idempotent). */
export const unsubscribeHash = async (hash: string): Promise<void> => {
  await getDb().execute({
    args: [hash, nowIso()],
    sql: "INSERT OR IGNORE INTO unsubscribed_emails (email_hash, created) VALUES (?, ?)",
  });
};

/** Remove an email hash from the unsubscribe list (idempotent). */
export const resubscribeHash = (hash: string): Promise<void> =>
  deleteByField("unsubscribed_emails", "email_hash", hash);

/**
 * Load every unsubscribed hash as a Set for fast membership tests when
 * filtering a recipient list before a marketing send.
 */
export const getUnsubscribedHashSet = async (): Promise<Set<string>> => {
  const rows = await queryAll<{ email_hash: string }>(
    "SELECT email_hash FROM unsubscribed_emails",
  );
  return new Set(rows.map((r) => r.email_hash));
};
