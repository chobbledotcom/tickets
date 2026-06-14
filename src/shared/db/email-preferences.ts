/**
 * Per-email marketing preferences and contact history.
 *
 * Keyed by the HMAC of the address (see `hashEmail`) — never the address
 * itself, the same blind-index approach used for ticket tokens and usernames.
 * Two concerns live in one row:
 *
 * - `unsubscribed` (plaintext): the marketing opt-out flag. Plaintext so the
 *   public, key-less /unsubscribe page can read and toggle it.
 * - `stats_blob` (hybrid-encrypted): `{c,t,s}` — contact count, last-contact
 *   ISO time, and last subject. Written when we email someone in bulk and read
 *   on the attendee page / bulk preview; only the admin private key can decrypt.
 *
 * A row is seeded at booking (count 0) so every attendee with an email has a
 * record to surface, then bumped on each bulk send.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import { decryptAttendeePII, encryptAttendeePII } from "#shared/crypto/keys.ts";
import {
  executeBatch,
  getDb,
  inPlaceholders,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";

/**
 * Compute the stored hash for an email address. Trimmed and lower-cased first
 * so "Bob@Example.com" and "bob@example.com " resolve to the same record.
 */
export const hashEmail = (email: string): Promise<string> =>
  hmacHash(email.trim().toLowerCase());

/** Run a single write statement against email_preferences. */
const run = async (sql: string, args: (string | number)[]): Promise<void> => {
  await getDb().execute({ args, sql });
};

// ── Unsubscribe state (plaintext) ───────────────────────────────────

/** Whether a given email hash is currently opted out of marketing. */
export const isHashUnsubscribed = async (hash: string): Promise<boolean> => {
  const row = await queryOne<{ unsubscribed: number }>(
    "SELECT unsubscribed FROM email_preferences WHERE email_hash = ?",
    [hash],
  );
  return row?.unsubscribed === 1;
};

/** Opt an email hash out of marketing (creating the row if needed). */
export const unsubscribeHash = (hash: string): Promise<void> =>
  run(
    "INSERT INTO email_preferences (email_hash, unsubscribed, created) VALUES (?, 1, ?) ON CONFLICT(email_hash) DO UPDATE SET unsubscribed = 1",
    [hash, nowIso()],
  );

/** Opt an email hash back into marketing. */
export const resubscribeHash = (hash: string): Promise<void> =>
  run("UPDATE email_preferences SET unsubscribed = 0 WHERE email_hash = ?", [
    hash,
  ]);

/** Load every unsubscribed hash as a Set for filtering a recipient list. */
export const getUnsubscribedHashSet = async (): Promise<Set<string>> => {
  const rows = await queryAll<{ email_hash: string }>(
    "SELECT email_hash FROM email_preferences WHERE unsubscribed = 1",
  );
  return new Set(rows.map((r) => r.email_hash));
};

// ── Contact history (encrypted) ─────────────────────────────────────

/** Decrypted contact history for an email. */
export type EmailStats = {
  contactCount: number;
  lastContact: string;
  lastSubject: string;
};

/** Compact on-disk shape of the encrypted stats blob. */
type StatsBlob = { c: number; t: string; s: string };

const EMPTY_STATS: EmailStats = {
  contactCount: 0,
  lastContact: "",
  lastSubject: "",
};

/** Decrypt a stats blob, returning zeroed stats for an unseen/empty row. */
const parseStats = async (
  blob: string,
  privateKey: CryptoKey,
): Promise<EmailStats> => {
  if (!blob) return EMPTY_STATS;
  const { c, t, s } = JSON.parse(
    await decryptAttendeePII(blob, privateKey),
  ) as StatsBlob;
  return { contactCount: c, lastContact: t, lastSubject: s };
};

/** Seed a preferences row at booking — a no-op when one already exists. */
export const ensureEmailPreference = (hash: string): Promise<void> =>
  run(
    "INSERT OR IGNORE INTO email_preferences (email_hash, created) VALUES (?, ?)",
    [hash, nowIso()],
  );

/** Load the (encrypted) stats blobs for many hashes, keyed by hash. */
const loadStatsBlobs = async (
  hashes: string[],
): Promise<Map<string, string>> => {
  const rows = await queryAll<{ email_hash: string; stats_blob: string }>(
    `SELECT email_hash, stats_blob FROM email_preferences
     WHERE email_hash IN (${inPlaceholders(hashes)})`,
    hashes,
  );
  return new Map(rows.map((r) => [r.email_hash, r.stats_blob]));
};

/** Read contact history for one email hash (zeroed when unseen). */
export const getEmailStats = async (
  hash: string,
  privateKey: CryptoKey,
): Promise<EmailStats> => {
  const row = await queryOne<{ stats_blob: string }>(
    "SELECT stats_blob FROM email_preferences WHERE email_hash = ?",
    [hash],
  );
  return parseStats(row?.stats_blob ?? "", privateKey);
};

/** Read contact counts for many hashes (missing rows count as 0). */
export const getContactCounts = async (
  hashes: string[],
  privateKey: CryptoKey,
): Promise<number[]> => {
  if (hashes.length === 0) return [];
  const byHash = await loadStatsBlobs(hashes);
  return Promise.all(
    hashes.map(
      async (h) =>
        (await parseStats(byHash.get(h) ?? "", privateKey)).contactCount,
    ),
  );
};

/**
 * Record one contact for each hash: bump the count and set last-contact time
 * and subject. Reads current counts (needs the private key) then re-encrypts
 * with the public key, preserving each row's unsubscribe state.
 */
export const recordContacts = async (
  hashes: string[],
  subject: string,
  privateKey: CryptoKey,
): Promise<void> => {
  if (hashes.length === 0) return;
  const now = nowIso();
  const byHash = await loadStatsBlobs(hashes);
  const statements = await Promise.all(
    hashes.map(async (hash) => {
      const current = await parseStats(byHash.get(hash) ?? "", privateKey);
      const blob: StatsBlob = {
        c: current.contactCount + 1,
        s: subject,
        t: now,
      };
      const encrypted = await encryptAttendeePII(
        JSON.stringify(blob),
        settings.publicKey,
      );
      return {
        args: [hash, encrypted, now],
        sql: "INSERT INTO email_preferences (email_hash, stats_blob, created) VALUES (?, ?, ?) ON CONFLICT(email_hash) DO UPDATE SET stats_blob = excluded.stats_blob",
      };
    }),
  );
  await executeBatch(statements);
};
