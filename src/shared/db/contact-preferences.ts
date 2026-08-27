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
import { hmacHash } from "#crypto/hashing.ts";
import { decryptWithOwnerKey, encryptWithOwnerKey } from "#crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { base64ToBase64Url } from "#crypto/utils.ts";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
  queryOne,
} from "#db/client.ts";
import { queryColumnSet } from "#db/query.ts";
import { settings } from "#db/settings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import { normalizePhone } from "#shared/phone.ts";
import { guardFor } from "#shared/validation/guard.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";
import { OptionalStringSchema } from "#shared/validation/string.ts";
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
 * proxies routinely mangle `%2F`). `base64ToBase64Url` writes the safe form a
 * `/admin/history/:hmac` path carries; this reads it back.
 */
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

export const getUnsubscribedHashSet = (): Promise<Set<string>> =>
  queryColumnSet(
    "SELECT contact_hash FROM contact_preferences WHERE unsubscribed = 1",
    "contact_hash",
  );

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

/** Load a contact's full record (counts + decrypted note) by its one-way
 * contact hash, using the request's private key to open the encrypted note. */
export type ContactRecordLoader = (
  hash: string,
  privateKey: CryptoKey,
) => Promise<ContactRecord>;

const StatsBlobSchema = v.strictObject({
  c: v.optional(integerAtLeast(0)),
  n: OptionalStringSchema,
  s: OptionalStringSchema,
  t: OptionalStringSchema,
});
type StatsBlob = v.InferOutput<typeof StatsBlobSchema>;
const statsJson = defineStoredJson(StatsBlobSchema);

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
  const { c, n, s, t } = statsJson.read(
    await decryptWithOwnerKey(blob, privateKey),
    "contact_preferences.stats_blob",
  );
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

export const getContactRecord: ContactRecordLoader = async (
  hash,
  privateKey,
) => {
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

/** {@link getContactRecord}, but a corrupt/undecryptable note must not take
 *  down the caller: log it for repair and fall back to
 *  {@link getRepairFallbackRecord} instead of throwing, so the real booking
 *  counts and the record's repair link stay visible. `context` names the
 *  caller in the logged detail (e.g. "contact history", "contact history
 *  editor"). */
export const getContactRecordOrRepair: (
  context: string,
) => ContactRecordLoader = (context) => async (hash, privateKey) => {
  try {
    return await getContactRecord(hash, privateKey);
  } catch (error) {
    logError({
      code: ErrorCode.DECRYPT_FAILED,
      detail: `${context} ${base64ToBase64Url(hash)}: ${error}`,
    });
    return getRepairFallbackRecord(hash);
  }
};

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
      statsJson.write(statsToBlob(stats), "contact_preferences.stats_blob"),
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
    statsJson.write(statsToBlob(record), "contact_preferences.stats_blob"),
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
