/**
 * Per-contact marketing preferences, visit history and contact history.
 *
 * Channel-agnostic: one row per contact identity (an email OR a phone), keyed
 * by the HMAC of a channel-namespaced identifier (see `contactHash`) — never
 * the address/number itself, the same blind-index approach used for ticket
 * tokens and usernames. The channel lives in the hash prefix, so a DB reader
 * cannot tell which rows are email vs SMS. Several concerns live in one row:
 *
 * - `unsubscribed` (plaintext): the marketing opt-out flag. Plaintext so the
 *   public, key-less /unsubscribe page can read and toggle it.
 * - `visits` (plaintext): the booking count, bumped keyless at booking. Read on
 *   the public checkout path to gate a returning-customer modifier, so it must
 *   stay outside the encrypted blob (the public path holds no private key).
 * - `last_activity` (plaintext, ms-epoch): bumped on booking and outreach; the
 *   key the fire-and-forget pruner deletes stale rows by.
 * - `stats_blob` (hybrid-encrypted): `{c,t,s}` — contact (outreach) count, last
 *   contact ISO time, and last subject. Written when we email/SMS someone in
 *   bulk and read on the attendee page / bulk preview; only the admin private
 *   key can decrypt. Each row is single-channel, so `c` is naturally "emails
 *   sent" for an email row and "SMS sent" for an SMS row.
 *
 * A row is seeded at booking (a keyless visit bump) so every attendee with an
 * email/phone has a record to surface, then bumped on each bulk send.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import {
  executeBatch,
  getDb,
  inPlaceholders,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import { normalizePhone } from "#shared/phone.ts";

/** Contact channel for a preferences row. The channel is encoded in the hash
 * prefix (see `contactHash`), never stored as a column. */
export type ContactChannel = "email" | "sms";

/**
 * Normalise a raw identifier for its channel so equivalent inputs resolve to
 * the same hash: email is trimmed + lower-cased; a phone is canonicalised to
 * `+{prefix}{local}` via `normalizePhone`, using the instance's dialling code
 * (`settings.phonePrefix`, e.g. "+44" — the leading "+" is stripped here since
 * `normalizePhone` re-adds it).
 */
const normalizeFor = (channel: ContactChannel, id: string): string =>
  channel === "email"
    ? id.trim().toLowerCase()
    : normalizePhone(id, settings.phonePrefix.replace(/^\+/, ""));

/**
 * Compute the stored hash for a contact identifier on a given channel. The
 * input is namespaced by channel (`email:` / `sms:`) so an email and a phone
 * can never collide in the one table, and each is normalised first so
 * equivalent forms (e.g. "Bob@Example.com" and "bob@example.com ") map to the
 * same record.
 */
export const contactHash = (
  channel: ContactChannel,
  id: string,
): Promise<string> => hmacHash(`${channel}:${normalizeFor(channel, id)}`);

/**
 * Compute the stored hash for an email address. Thin wrapper over
 * `contactHash("email", …)`; trimmed and lower-cased first so "Bob@Example.com"
 * and "bob@example.com " resolve to the same record.
 */
export const hashEmail = (email: string): Promise<string> =>
  contactHash("email", email);

/**
 * Compute the stored hash for a phone number (SMS channel). The number is
 * normalised via `normalizePhone` against the instance's dialling code before
 * hashing, so equivalent forms resolve to the same record.
 */
export const hashPhone = (phone: string): Promise<string> =>
  contactHash("sms", phone);

/** Run a single write statement against contact_preferences. */
const run = async (sql: string, args: (string | number)[]): Promise<void> => {
  await getDb().execute({ args, sql });
};

// ── Unsubscribe state (plaintext) ───────────────────────────────────

/** Whether a given contact hash is currently opted out of marketing. */
export const isHashUnsubscribed = async (hash: string): Promise<boolean> => {
  const row = await queryOne<{ unsubscribed: number }>(
    "SELECT unsubscribed FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return row?.unsubscribed === 1;
};

/** Opt a contact hash out of marketing (creating the row if needed). */
export const unsubscribeHash = (hash: string): Promise<void> =>
  run(
    "INSERT INTO contact_preferences (contact_hash, unsubscribed, last_activity) VALUES (?, 1, ?) ON CONFLICT(contact_hash) DO UPDATE SET unsubscribed = 1",
    [hash, nowMs()],
  );

/** Opt a contact hash back into marketing. */
export const resubscribeHash = (hash: string): Promise<void> =>
  run(
    "UPDATE contact_preferences SET unsubscribed = 0 WHERE contact_hash = ?",
    [hash],
  );

/** Load every unsubscribed hash as a Set for filtering a recipient list. */
export const getUnsubscribedHashSet = async (): Promise<Set<string>> => {
  const rows = await queryAll<{ contact_hash: string }>(
    "SELECT contact_hash FROM contact_preferences WHERE unsubscribed = 1",
  );
  return new Set(rows.map((r) => r.contact_hash));
};

// ── Visit counter (plaintext, keyless) ──────────────────────────────

/**
 * Record one visit (a booking) for a contact hash: increment `visits` and set
 * `last_activity` to now. Keyless — touches only plaintext columns, never the
 * encrypted blob (the public booking path holds no private key). Called once
 * per order for each identifier present.
 */
export const recordVisit = (hash: string): Promise<void> =>
  run(
    "INSERT INTO contact_preferences (contact_hash, last_activity, visits) VALUES (?, ?, 1) ON CONFLICT(contact_hash) DO UPDATE SET visits = visits + 1, last_activity = excluded.last_activity",
    [hash, nowMs()],
  );

/** Read the plaintext booking count for a contact hash (0 when absent). Used
 * keyless by the returning-customer modifier gate. */
export const getVisits = async (hash: string): Promise<number> => {
  const row = await queryOne<{ visits: number }>(
    "SELECT visits FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return row?.visits ?? 0;
};

// ── Erasure ─────────────────────────────────────────────────────────

/** Delete a contact's row entirely — the right-to-erasure "forget me" action.
 * The hash is one-way, so once the row is gone the contact cannot be recognised
 * or reached again. */
export const forgetContact = (hash: string): Promise<void> =>
  run("DELETE FROM contact_preferences WHERE contact_hash = ?", [hash]);

// ── Contact history (encrypted) ─────────────────────────────────────

/** Decrypted contact (outreach) history for a contact. */
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
    await decryptWithOwnerKey(blob, privateKey),
  ) as StatsBlob;
  return { contactCount: c, lastContact: t, lastSubject: s };
};

/** Load the (encrypted) stats blobs for many hashes, keyed by hash. */
const loadStatsBlobs = async (
  hashes: string[],
): Promise<Map<string, string>> => {
  const rows = await queryAll<{ contact_hash: string; stats_blob: string }>(
    `SELECT contact_hash, stats_blob FROM contact_preferences
     WHERE contact_hash IN (${inPlaceholders(hashes)})`,
    hashes,
  );
  return new Map(rows.map((r) => [r.contact_hash, r.stats_blob]));
};

/** Read contact history for one contact hash (zeroed when unseen). */
export const getEmailStats = async (
  hash: string,
  privateKey: CryptoKey,
): Promise<EmailStats> => {
  const row = await queryOne<{ stats_blob: string }>(
    "SELECT stats_blob FROM contact_preferences WHERE contact_hash = ?",
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
 * Record one contact (outreach) for each hash: bump the count and set
 * last-contact time and subject, and bump `last_activity` to now. Reads current
 * counts (needs the private key) then re-encrypts with the public key,
 * preserving each row's unsubscribe state and visit count.
 */
export const recordContacts = async (
  hashes: string[],
  subject: string,
  privateKey: CryptoKey,
): Promise<void> => {
  if (hashes.length === 0) return;
  const now = nowIso();
  const nowMillis = nowMs();
  const byHash = await loadStatsBlobs(hashes);
  const statements = await Promise.all(
    hashes.map(async (hash) => {
      const current = await parseStats(byHash.get(hash) ?? "", privateKey);
      const blob: StatsBlob = {
        c: current.contactCount + 1,
        s: subject,
        t: now,
      };
      const encrypted = await encryptWithOwnerKey(
        JSON.stringify(blob),
        settings.publicKey,
      );
      return {
        args: [hash, encrypted, nowMillis],
        sql: "INSERT INTO contact_preferences (contact_hash, stats_blob, last_activity) VALUES (?, ?, ?) ON CONFLICT(contact_hash) DO UPDATE SET stats_blob = excluded.stats_blob, last_activity = excluded.last_activity",
      };
    }),
  );
  await executeBatch(statements);
};
