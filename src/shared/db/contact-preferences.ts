/**
 * Per-contact marketing preferences, visit history and contact history.
 *
 * One row represents one contact identity, keyed by an irreversible HMAC blind
 * index rather than the email address or phone number itself. Email hashes keep
 * the legacy email_preferences input shape so existing opt-out hashes still
 * match after migration; SMS hashes are channel-namespaced before hashing.
 */

/* jscpd:ignore-start */
import * as v from "valibot";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import { normalizePhone } from "#shared/phone.ts";
import { guardFor } from "#shared/validation/guard.ts";
/* jscpd:ignore-end */

export const ContactChannelSchema = v.picklist(["email", "sms"]);
export type ContactChannel = v.InferOutput<typeof ContactChannelSchema>;

/** Type guard: narrows an arbitrary string to a {@link ContactChannel}. */
export const isContactChannel = guardFor(ContactChannelSchema);

const normalizeFor = (channel: ContactChannel, id: string): string =>
  channel === "email"
    ? id.trim().toLowerCase()
    : normalizePhone(id, settings.phonePrefix.replace(/^\+/, ""));

export const contactHash = (
  channel: ContactChannel,
  id: string,
): Promise<string> =>
  channel === "email"
    ? hmacHash(normalizeFor(channel, id))
    : hmacHash(`${channel}:${normalizeFor(channel, id)}`);

export const hashEmail = (email: string): Promise<string> =>
  contactHash("email", email);

export const hashPhone = (phone: string): Promise<string> =>
  contactHash("sms", phone);

/**
 * The contact hash is standard base64, so it can contain `+`, `/` and `=` —
 * characters that break a URL path segment (a `/` splits the path, and CDNs/
 * proxies routinely mangle `%2F`). These convert to/from a base64url form that
 * is safe to carry in `/admin/history/:hmac` without percent-encoding.
 */
export const toContactHashParam = (hash: string): string =>
  hash.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const fromContactHashParam = (param: string): string => {
  const base64 = param.replaceAll("-", "+").replaceAll("_", "/");
  return base64 + "=".repeat((4 - (base64.length % 4)) % 4);
};

const run = async (sql: string, args: (string | number)[]): Promise<void> => {
  await execute(sql, args);
};

export const isHashUnsubscribed = async (hash: string): Promise<boolean> => {
  const row = await queryOne<{ unsubscribed: number }>(
    "SELECT unsubscribed FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return row?.unsubscribed === 1;
};

export const unsubscribeHash = (hash: string): Promise<void> =>
  run(
    "INSERT INTO contact_preferences (contact_hash, unsubscribed, last_activity) VALUES (?, 1, ?) ON CONFLICT(contact_hash) DO UPDATE SET unsubscribed = 1, last_activity = excluded.last_activity",
    [hash, nowMs()],
  );

export const resubscribeHash = (hash: string): Promise<void> =>
  run(
    "UPDATE contact_preferences SET unsubscribed = 0, last_activity = ? WHERE contact_hash = ?",
    [nowMs(), hash],
  );

export const getUnsubscribedHashSet = async (): Promise<Set<string>> => {
  const rows = await queryAll<{ contact_hash: string }>(
    "SELECT contact_hash FROM contact_preferences WHERE unsubscribed = 1",
  );
  return new Set(rows.map((r) => r.contact_hash));
};

/** Booking origin: an online public checkout vs an admin manual add. Each is
 * counted in its own plaintext column so the split survives without the owner
 * key — public paths have no private key, so they cannot touch the encrypted
 * stats_blob. */
export type BookingSource = "admin" | "public";

/** Plaintext counter columns that the keyless public paths can increment. */
type CountColumn = "visits" | "public_booking_count" | "admin_booking_count";

/** The plaintext booking-count column for each source. */
const BOOKING_COLUMN: Record<BookingSource, CountColumn> = {
  admin: "admin_booking_count",
  public: "public_booking_count",
};

/** One-character tag stored before each ticket token so a decrypted entry knows
 * which source booked it — the encrypted equivalent of the two plaintext
 * booking-count columns (`p` = online checkout, `a` = admin manual add). */
const SOURCE_TAG: Record<BookingSource, "p" | "a"> = {
  admin: "a",
  public: "p",
};

const TAG_SOURCE: Record<string, BookingSource> = {
  a: "admin",
  p: "public",
};

/** A booked ticket token linked to a contact, with the source that booked it. */
export type BookingToken = { source: BookingSource; token: string };

/**
 * Encrypt one "<tag><token>" entry for the append-only tokens blob, terminated
 * by a newline so entries concatenate on the column without a separator table.
 * A hybrid ciphertext is base64 + colons only (never a newline), so the newline
 * is an unambiguous delimiter. Encryption needs only the public key, so the
 * keyless public checkout can build this without the owner private key — the
 * whole reason the tokens live here rather than in the read-modify-write
 * stats_blob.
 */
const encryptTokenEntry = async (
  source: BookingSource,
  token: string,
): Promise<string> =>
  `${await encryptWithOwnerKey(
    `${SOURCE_TAG[source]}${token}`,
    settings.publicKey,
  )}\n`;

/** Split a tokens blob into its per-entry ciphertext lines (drops the trailing
 * blank left by the newline terminator). */
const splitTokenBlob = (blob: string): OwnerKeyEncrypted[] =>
  blob.split("\n").filter(Boolean) as OwnerKeyEncrypted[];

/** Decrypt one entry back to its source + ticket token. */
const parseTokenEntry = async (
  line: OwnerKeyEncrypted,
  privateKey: CryptoKey,
): Promise<BookingToken> => {
  const decoded = await decryptWithOwnerKey(line, privateKey);
  return { source: TAG_SOURCE[decoded[0]!]!, token: decoded.slice(1) };
};

/** Increment one plaintext counter, creating the row on first activity. Shared
 * by visits and the per-source booking counts so the upsert lives in one place.
 * The column is from a fixed internal union, never user input. */
const incrementCount =
  (column: CountColumn) =>
  (hash: string): Promise<void> =>
    run(
      `INSERT INTO contact_preferences (contact_hash, last_activity, ${column}) VALUES (?, ?, 1) ON CONFLICT(contact_hash) DO UPDATE SET ${column} = ${column} + 1, last_activity = excluded.last_activity`,
      [hash, nowMs()],
    );

/** Reverse one increment, clamped at zero. Only an existing row is touched: a
 * missing row means nothing was recorded, so there is nothing to undo. Used to
 * compensate a booking/visit when the order is rolled back after creation. */
const decrementCount =
  (column: CountColumn) =>
  (hash: string): Promise<void> =>
    run(
      `UPDATE contact_preferences SET ${column} = MAX(${column} - 1, 0), last_activity = ? WHERE contact_hash = ?`,
      [nowMs(), hash],
    );

export const recordVisit = incrementCount("visits");
export const unrecordVisit = decrementCount("visits");

/**
 * Record one booking against a contact: bump its source's plaintext count AND
 * append the booked ticket token to the encrypted, append-only tokens blob, in
 * one upsert. Both halves only need the public key, so the keyless public
 * checkout/webhook paths can call it without the owner private key. The append
 * (`|| excluded.attendee_tokens_blob`) never reads the existing value, which is
 * why an owner-encrypted list can grow on a keyless path.
 */
export const recordBooking = async (
  hash: string,
  source: BookingSource,
  ticketToken: string,
): Promise<void> => {
  const column = BOOKING_COLUMN[source];
  await run(
    `INSERT INTO contact_preferences (contact_hash, last_activity, ${column}, attendee_tokens_blob)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(contact_hash) DO UPDATE SET
       ${column} = ${column} + 1,
       last_activity = excluded.last_activity,
       attendee_tokens_blob = attendee_tokens_blob || excluded.attendee_tokens_blob`,
    [hash, nowMs(), await encryptTokenEntry(source, ticketToken)],
  );
};

/** Reverse a {@link recordBooking}'s count, e.g. when an order is rolled back.
 * The token entry is left in place: a rollback deletes the attendee, so its
 * token resolves to nothing and is filtered out on read, and the keyless path
 * cannot decrypt to prune it anyway. */
export const unrecordBooking = (
  hash: string,
  source: BookingSource,
): Promise<void> => decrementCount(BOOKING_COLUMN[source])(hash);

/** Append a ticket token to a contact's encrypted list WITHOUT touching the
 * booking counts — used to re-home a token when an attendee's email/phone
 * changes, where the booking already happened and only its owning contact
 * moves. */
export const addBookingToken = async (
  hash: string,
  ticketToken: string,
  source: BookingSource,
): Promise<void> => {
  await run(
    `INSERT INTO contact_preferences (contact_hash, last_activity, attendee_tokens_blob)
     VALUES (?, ?, ?)
     ON CONFLICT(contact_hash) DO UPDATE SET
       last_activity = excluded.last_activity,
       attendee_tokens_blob = attendee_tokens_blob || excluded.attendee_tokens_blob`,
    [hash, nowMs(), await encryptTokenEntry(source, ticketToken)],
  );
};

/** Load a contact's token entries as raw ciphertext lines (empty when the
 * contact has no row or an empty blob). Shared by the decrypting read and the
 * remove path so the load-and-split lives in one place. */
const loadTokenLines = async (hash: string): Promise<OwnerKeyEncrypted[]> => {
  const row = await queryOne<{ attendee_tokens_blob: string }>(
    "SELECT attendee_tokens_blob FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return row?.attendee_tokens_blob
    ? splitTokenBlob(row.attendee_tokens_blob)
    : [];
};

/** Read a contact's booked ticket tokens (empty when none on file). Decrypting
 * needs the owner private key, so this is an admin-only read. */
export const getBookingTokens = async (
  hash: string,
  privateKey: CryptoKey,
): Promise<BookingToken[]> =>
  Promise.all(
    (await loadTokenLines(hash)).map((line) =>
      parseTokenEntry(line, privateKey),
    ),
  );

/** Remove the first entry for `ticketToken` from a contact's encrypted list,
 * rewriting the surviving ciphertext lines unchanged (no re-encryption).
 * Returns the removed entry's source so a move can re-add it under the same
 * source, or null when the contact never booked this token (e.g. a contact that
 * predates this feature — nothing to move). Keyed: it must decrypt to find the
 * matching entry. */
export const removeBookingToken = async (
  hash: string,
  ticketToken: string,
  privateKey: CryptoKey,
): Promise<BookingSource | null> => {
  const entries = await Promise.all(
    (await loadTokenLines(hash)).map(async (line) => ({
      line,
      ...(await parseTokenEntry(line, privateKey)),
    })),
  );
  const match = entries.find((entry) => entry.token === ticketToken);
  if (!match) return null;
  const kept = entries.filter((entry) => entry !== match);
  await run(
    "UPDATE contact_preferences SET attendee_tokens_blob = ?, last_activity = ? WHERE contact_hash = ?",
    [
      kept.length ? `${kept.map((entry) => entry.line).join("\n")}\n` : "",
      nowMs(),
      hash,
    ],
  );
  return match.source;
};

/** Move a token between two contacts of one channel when its attendee's value
 * for that channel changed: pull it from the old contact (learning its source)
 * and re-add it to the new one. No-ops when the identity is unchanged, when the
 * old contact never held the token (nothing to move), or when the new value is
 * blank (a cleared field just drops the link). */
const moveChannelToken = async (
  channel: ContactChannel,
  ticketToken: string,
  oldValue: string,
  newValue: string,
  privateKey: CryptoKey,
): Promise<void> => {
  const oldHash = oldValue.trim() ? await contactHash(channel, oldValue) : null;
  const newHash = newValue.trim() ? await contactHash(channel, newValue) : null;
  if (oldHash === null || oldHash === newHash) return;
  const source = await removeBookingToken(oldHash, ticketToken, privateKey);
  if (source === null || newHash === null) return;
  await addBookingToken(newHash, ticketToken, source);
};

/** Re-home an attendee's ticket token when its email and/or phone changed, one
 * channel at a time, so a relinked booking follows the attendee to whichever
 * contact now owns it. Keyed (runs only from the admin edit path). */
export const moveAttendeeContactTokens = async (
  ticketToken: string,
  before: { email: string; phone: string },
  after: { email: string; phone: string },
  privateKey: CryptoKey,
): Promise<void> => {
  await moveChannelToken(
    "email",
    ticketToken,
    before.email,
    after.email,
    privateKey,
  );
  await moveChannelToken(
    "sms",
    ticketToken,
    before.phone,
    after.phone,
    privateKey,
  );
};

export const getVisits = async (hash: string): Promise<number> => {
  const row = await queryOne<{ visits: number }>(
    "SELECT visits FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return row?.visits ?? 0;
};

/** Delete a contact's record (GDPR erasure). Returns how many rows were
 * removed: 1 when a record existed for the hash, 0 when none did — letting
 * callers report "erased" versus "nothing on file" without a prior lookup. */
export const forgetContact = async (hash: string): Promise<number> => {
  const result = await execute(
    "DELETE FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return result.rowsAffected;
};

/** Owner-encrypted outreach stats held in the stats_blob (needs the owner key
 * to read or write). Booking counts are deliberately NOT here — they live in
 * plaintext columns so the keyless public checkout/webhook paths can maintain
 * them without the owner private key. */
export type ContactStats = {
  contactCount: number;
  lastContact: string;
  lastSubject: string;
  adminNotes: string;
};

/** A contact's full operator-facing record: the encrypted outreach stats plus
 * the plaintext per-source counters. Backs both the read-only attendee panel
 * and the editable /admin/history/:hmac page. */
export type ContactRecord = ContactStats & {
  visits: number;
  publicBookingCount: number;
  adminBookingCount: number;
};

type StatsBlob = {
  c?: number;
  t?: string;
  s?: string;
  n?: string;
};

const EMPTY_STATS: ContactStats = {
  adminNotes: "",
  contactCount: 0,
  lastContact: "",
  lastSubject: "",
};

const parseStats = async (
  blob: OwnerKeyEncrypted | "",
  privateKey: CryptoKey,
): Promise<ContactStats> => {
  if (!blob) return EMPTY_STATS;
  const { c, n, s, t } = JSON.parse(
    await decryptWithOwnerKey(blob, privateKey),
  ) as StatsBlob;
  return {
    adminNotes: n ?? "",
    contactCount: c ?? 0,
    lastContact: t ?? "",
    lastSubject: s ?? "",
  };
};

const loadStatsBlobs = async (
  hashes: string[],
): Promise<Map<string, OwnerKeyEncrypted | "">> => {
  const rows = await queryAll<{
    contact_hash: string;
    stats_blob: OwnerKeyEncrypted | "";
  }>(
    `SELECT contact_hash, stats_blob FROM contact_preferences
     WHERE contact_hash IN (${inPlaceholders(hashes)})`,
    hashes,
  );
  return new Map(rows.map((r) => [r.contact_hash, r.stats_blob]));
};

type CountColumnsRow = {
  visits: number;
  public_booking_count: number;
  admin_booking_count: number;
};

type ContactCountFields = Pick<
  ContactRecord,
  "visits" | "publicBookingCount" | "adminBookingCount"
>;

/** Map a row's plaintext count columns (or a missing row) to the camelCase
 * count fields, defaulting to zero. */
const countFieldsFromRow = (
  row: CountColumnsRow | null,
): ContactCountFields => ({
  adminBookingCount: row?.admin_booking_count ?? 0,
  publicBookingCount: row?.public_booking_count ?? 0,
  visits: row?.visits ?? 0,
});

export const getContactRecord = async (
  hash: string,
  privateKey: CryptoKey,
): Promise<ContactRecord> => {
  const row = await queryOne<
    CountColumnsRow & { stats_blob: OwnerKeyEncrypted | "" }
  >(
    "SELECT visits, public_booking_count, admin_booking_count, stats_blob FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return {
    ...(await parseStats(row?.stats_blob ?? "", privateKey)),
    ...countFieldsFromRow(row),
  };
};

/** The plaintext count columns for one contact — readable without the private
 * key and without touching the (possibly corrupt) encrypted stats blob. Lets a
 * caller recover a record's counts when {@link getContactRecord} cannot decrypt
 * the note, so a repair never silently zeros real booking history. */
export const getContactCountFields = async (
  hash: string,
): Promise<ContactCountFields> => {
  const row = await queryOne<CountColumnsRow>(
    "SELECT visits, public_booking_count, admin_booking_count FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return countFieldsFromRow(row);
};

/** A repairable view of a contact whose encrypted note cannot be read: the real
 * plaintext counts with blank note fields. Both the attendee history panel and
 * the record editor fall back to this so a corrupt row stays visible (and its
 * repair link reachable) instead of vanishing. */
export const getRepairFallbackRecord = async (
  hash: string,
): Promise<ContactRecord> => ({
  ...EMPTY_STATS,
  ...(await getContactCountFields(hash)),
});

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

const statsToBlob = (stats: ContactStats): StatsBlob => ({
  c: stats.contactCount,
  n: stats.adminNotes,
  s: stats.lastSubject,
  t: stats.lastContact,
});

const saveStats = async (
  hash: string,
  stats: ContactStats,
  lastActivity = nowMs(),
): Promise<{ args: (string | number)[]; sql: string }> => ({
  args: [
    hash,
    await encryptWithOwnerKey(
      JSON.stringify(statsToBlob(stats)),
      settings.publicKey,
    ),
    lastActivity,
  ],
  sql: "INSERT INTO contact_preferences (contact_hash, stats_blob, last_activity) VALUES (?, ?, ?) ON CONFLICT(contact_hash) DO UPDATE SET stats_blob = excluded.stats_blob, last_activity = excluded.last_activity",
});

const updateStatsForHashes = async (
  hashes: string[],
  privateKey: CryptoKey,
  update: (current: ContactStats) => ContactStats,
): Promise<void> => {
  if (hashes.length === 0) return;
  const lastActivity = nowMs();
  const byHash = await loadStatsBlobs(hashes);
  const statements = await Promise.all(
    hashes.map(async (hash) =>
      saveStats(
        hash,
        update(await parseStats(byHash.get(hash) ?? "", privateKey)),
        lastActivity,
      ),
    ),
  );
  await executeBatch(statements);
};

export const recordContacts = (
  hashes: string[],
  subject: string,
  privateKey: CryptoKey,
): Promise<void> => {
  const contactedAt = nowIso();
  return updateStatsForHashes(hashes, privateKey, (current) => ({
    ...current,
    contactCount: current.contactCount + 1,
    lastContact: contactedAt,
    lastSubject: subject,
  }));
};

/** Overwrite a contact's full record from the /admin/history editor: the
 * plaintext counters and the owner-encrypted stats (including the admin note)
 * in a single atomic upsert. Encryption needs only the public key, so this is
 * symmetric with {@link getContactRecord}'s decrypting read. */
export const saveContactRecord = async (
  hash: string,
  record: ContactRecord,
): Promise<void> => {
  const blob = await encryptWithOwnerKey(
    JSON.stringify(statsToBlob(record)),
    settings.publicKey,
  );
  await execute(
    `INSERT INTO contact_preferences (contact_hash, visits, public_booking_count, admin_booking_count, stats_blob, last_activity)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(contact_hash) DO UPDATE SET
       visits = excluded.visits,
       public_booking_count = excluded.public_booking_count,
       admin_booking_count = excluded.admin_booking_count,
       stats_blob = excluded.stats_blob,
       last_activity = excluded.last_activity`,
    [
      hash,
      record.visits,
      record.publicBookingCount,
      record.adminBookingCount,
      blob,
      nowMs(),
    ],
  );
};
