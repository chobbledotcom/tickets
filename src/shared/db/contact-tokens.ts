/**
 * Encrypted booking-token links for contact history.
 *
 * Contact preferences own the contact row and outreach stats. This module owns
 * the append-only encrypted ticket-token list that lets an admin resolve a
 * contact's other bookings without decrypting every attendee.
 */

import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  type ContactChannel,
  contactHash,
} from "#shared/db/contact-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import { nowMs } from "#shared/now.ts";

/** Booking origin: an online public checkout vs an admin manual add. Each is
 * counted in its own plaintext column so the split survives without the owner
 * key. */
export type BookingSource = "admin" | "public";

/** A booked ticket token linked to a contact, with the source that booked it. */
export type BookingToken = { source: BookingSource; token: string };

/** Plaintext booking-count columns that the keyless public paths can touch. */
type BookingCountColumn = "public_booking_count" | "admin_booking_count";

/** The plaintext booking-count column for each source. */
const BOOKING_COLUMN: Record<BookingSource, BookingCountColumn> = {
  admin: "admin_booking_count",
  public: "public_booking_count",
};

/** One-character tag stored before each ticket token in the encrypted list. */
const SOURCE_TAG: Record<BookingSource, "p" | "a"> = {
  admin: "a",
  public: "p",
};

const TAG_SOURCE: Record<string, BookingSource> = {
  a: "admin",
  p: "public",
};

/**
 * Encrypt one "<tag><token>" entry for the append-only tokens blob, terminated
 * by a newline so entries concatenate on the column without a separator table.
 * Encryption needs only the public key, so the public checkout can append
 * without the owner private key.
 */
const encryptTokenEntry = async (
  source: BookingSource,
  token: string,
): Promise<string> =>
  `${await encryptWithOwnerKey(
    `${SOURCE_TAG[source]}${token}`,
    settings.publicKey,
  )}\n`;

/** Split a tokens blob into its per-entry ciphertext lines. */
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

/**
 * Record one booking against a contact: bump its source's plaintext count and
 * append the booked ticket token to the encrypted, append-only token list.
 */
export const recordBooking = async (
  hash: string,
  source: BookingSource,
  ticketToken: string,
): Promise<void> => {
  const column = BOOKING_COLUMN[source];
  await execute(
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
 * token resolves to nothing and is filtered out on read. */
export const unrecordBooking = async (
  hash: string,
  source: BookingSource,
): Promise<void> => {
  const column = BOOKING_COLUMN[source];
  await execute(
    `UPDATE contact_preferences SET ${column} = MAX(${column} - 1, 0), last_activity = ? WHERE contact_hash = ?`,
    [nowMs(), hash],
  );
};

/** Append a ticket token to a contact's encrypted list without touching counts. */
const addBookingToken = async (
  hash: string,
  ticketToken: string,
  source: BookingSource,
): Promise<void> => {
  await execute(
    `INSERT INTO contact_preferences (contact_hash, last_activity, attendee_tokens_blob)
     VALUES (?, ?, ?)
     ON CONFLICT(contact_hash) DO UPDATE SET
       last_activity = excluded.last_activity,
       attendee_tokens_blob = attendee_tokens_blob || excluded.attendee_tokens_blob`,
    [hash, nowMs(), await encryptTokenEntry(source, ticketToken)],
  );
};

/** Load a contact's token entries as raw ciphertext lines. */
const loadTokenLines = async (hash: string): Promise<OwnerKeyEncrypted[]> => {
  const row = await queryOne<{ attendee_tokens_blob: string }>(
    "SELECT attendee_tokens_blob FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return row?.attendee_tokens_blob
    ? splitTokenBlob(row.attendee_tokens_blob)
    : [];
};

/** Read a contact's booked ticket tokens. Decrypting needs the owner key. */
export const getBookingTokens = async (
  hash: string,
  privateKey: CryptoKey,
): Promise<BookingToken[]> =>
  Promise.all(
    (await loadTokenLines(hash)).map((line) =>
      parseTokenEntry(line, privateKey),
    ),
  );

/** Read only the newest booked ticket tokens, decrypting no older entries. */
export const getRecentBookingTokens = async (
  hash: string,
  privateKey: CryptoKey,
  limit: number,
): Promise<BookingToken[]> =>
  Promise.all(
    (await loadTokenLines(hash))
      .slice(-Math.max(0, limit))
      .map((line) => parseTokenEntry(line, privateKey)),
  );

/** Remove the first entry for `ticketToken` from a contact's encrypted list. */
const removeBookingToken = async (
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
  // Delete just this entry's ciphertext line in place. REPLACE operates on the
  // column's current value at write time, so a keyless checkout append that
  // lands after our read is preserved instead of overwritten by a stale rewrite.
  await execute(
    "UPDATE contact_preferences SET attendee_tokens_blob = REPLACE(attendee_tokens_blob, ?, ''), last_activity = ? WHERE contact_hash = ?",
    [`${match.line}\n`, nowMs(), hash],
  );
  return match.source;
};

/** Add the token when it is missing, preserving the existing list otherwise. */
const ensureBookingToken = async (
  hash: string,
  ticketToken: string,
  source: BookingSource,
  privateKey: CryptoKey,
): Promise<void> => {
  const tokens = await getBookingTokens(hash, privateKey);
  if (tokens.some((entry) => entry.token === ticketToken)) return;
  await addBookingToken(hash, ticketToken, source);
};

type ContactTokenValues = { email: string; phone: string };

export type ContactTokenSync = {
  ticketToken: string;
  before: ContactTokenValues;
  after: ContactTokenValues;
  privateKey: CryptoKey;
  /** Source to use when a token is first attached by this admin-side sync. */
  source: BookingSource;
  /** Only real bookings should be linked into Previous bookings. */
  hasBooking: boolean;
};

const hashForValue = (
  channel: ContactChannel,
  value: string,
): Promise<string | null> =>
  value.trim() ? contactHash(channel, value) : Promise.resolve(null);

const valueFor = (
  channel: ContactChannel,
  values: ContactTokenValues,
): string => (channel === "email" ? values.email : values.phone);

const syncChannelToken = async (
  channel: ContactChannel,
  sync: ContactTokenSync,
): Promise<void> => {
  const oldHash = await hashForValue(channel, valueFor(channel, sync.before));
  const newHash = await hashForValue(channel, valueFor(channel, sync.after));
  const changed = oldHash !== newHash;
  const removedSource =
    oldHash !== null && changed
      ? await removeBookingToken(oldHash, sync.ticketToken, sync.privateKey)
      : null;

  if (!sync.hasBooking || newHash === null) return;
  await ensureBookingToken(
    newHash,
    sync.ticketToken,
    removedSource ?? sync.source,
    sync.privateKey,
  );
};

/** Keep an attendee's ticket token under the contacts that currently own it. */
export const syncAttendeeContactTokens = async (
  sync: ContactTokenSync,
): Promise<void> => {
  await syncChannelToken("email", sync);
  await syncChannelToken("sms", sync);
};
