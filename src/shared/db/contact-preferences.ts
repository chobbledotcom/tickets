/**
 * Per-contact marketing preferences, visit history and contact history.
 *
 * One row represents one contact identity, keyed by an irreversible HMAC blind
 * index rather than the email address or phone number itself. Email hashes keep
 * the legacy email_preferences input shape so existing opt-out hashes still
 * match after migration; SMS hashes are channel-namespaced before hashing.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
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

export type ContactChannel = "email" | "sms";

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

export const recordVisit = (hash: string): Promise<void> =>
  run(
    "INSERT INTO contact_preferences (contact_hash, last_activity, visits) VALUES (?, ?, 1) ON CONFLICT(contact_hash) DO UPDATE SET visits = visits + 1, last_activity = excluded.last_activity",
    [hash, nowMs()],
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

export type ContactStats = {
  contactCount: number;
  lastContact: string;
  lastSubject: string;
  bookingCount: number;
  lastBookedOnline: boolean;
  lastBookingDate: string;
  adminNotes: string;
};

type StatsBlob = {
  c?: number;
  t?: string;
  s?: string;
  b?: number;
  o?: boolean;
  d?: string;
  n?: string;
};

const EMPTY_STATS: ContactStats = {
  adminNotes: "",
  bookingCount: 0,
  contactCount: 0,
  lastBookedOnline: false,
  lastBookingDate: "",
  lastContact: "",
  lastSubject: "",
};

const parseStats = async (
  blob: string,
  privateKey: CryptoKey,
): Promise<ContactStats> => {
  if (!blob) return EMPTY_STATS;
  const { b, c, d, n, o, s, t } = JSON.parse(
    await decryptWithOwnerKey(blob, privateKey),
  ) as StatsBlob;
  return {
    adminNotes: n ?? "",
    bookingCount: b ?? 0,
    contactCount: c ?? 0,
    lastBookedOnline: o ?? false,
    lastBookingDate: d ?? "",
    lastContact: t ?? "",
    lastSubject: s ?? "",
  };
};

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

export const getContactStats = async (
  hash: string,
  privateKey: CryptoKey,
): Promise<ContactStats> => {
  const row = await queryOne<{ stats_blob: string }>(
    "SELECT stats_blob FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return parseStats(row?.stats_blob ?? "", privateKey);
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
  b: stats.bookingCount,
  c: stats.contactCount,
  d: stats.lastBookingDate,
  n: stats.adminNotes,
  o: stats.lastBookedOnline,
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

export const recordBookingStats = (
  hashes: string[],
  bookedOnline: boolean,
  privateKey: CryptoKey,
): Promise<void> => {
  const bookedAt = nowIso();
  return updateStatsForHashes(hashes, privateKey, (current) => ({
    ...current,
    bookingCount: current.bookingCount + 1,
    lastBookedOnline: bookedOnline,
    lastBookingDate: bookedAt,
  }));
};

export const saveContactAdminNotes = (
  hash: string,
  adminNotes: string,
  privateKey: CryptoKey,
): Promise<void> =>
  updateStatsForHashes([hash], privateKey, (current) => ({
    ...current,
    adminNotes,
  }));
