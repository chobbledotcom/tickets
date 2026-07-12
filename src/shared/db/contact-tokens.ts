/**
 * Encrypted booking-token links for contact history.
 *
 * Contact preferences own the contact row and outreach stats. This module owns
 * the append-only encrypted ticket-token list that lets an admin resolve a
 * contact's other bookings without decrypting every attendee.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import type { BlindIndex, OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
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
type BookingActivityWriter = (
  hash: string,
  source: BookingSource,
  ticketToken: string,
) => Promise<void>;

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

const TOKEN_LINE_SEPARATOR = "\t";

const tokenMarkerFor = (
  contactHash: string,
  ticketToken: string,
): Promise<BlindIndex> =>
  hmacHash(`contact-token:${contactHash}:${ticketToken}`);

type StoredTokenLine = {
  encrypted: OwnerKeyEncrypted;
  marker: BlindIndex | null;
  raw: string;
};

/**
 * Create one searchable token entry for the append-only tokens blob,
 * terminated by a newline so entries concatenate on the column without a
 * separator table. The marker is scoped to this contact row, so two contact
 * rows cannot be linked just because they share one booking token. The source
 * and token stay owner-key-encrypted.
 */
const encryptTokenEntry = async (
  hash: string,
  source: BookingSource,
  token: string,
): Promise<string> => {
  const marker = await tokenMarkerFor(hash, token);
  const encrypted = await encryptWithOwnerKey(
    `${SOURCE_TAG[source]}${token}`,
    settings.publicKey,
  );
  return `${marker}${TOKEN_LINE_SEPARATOR}${encrypted}\n`;
};

/** Split a tokens blob into its per-entry stored lines. */
const splitTokenBlob = (blob: string): StoredTokenLine[] =>
  blob
    .split("\n")
    .filter(Boolean)
    .map((raw) => {
      const separatorAt = raw.indexOf(TOKEN_LINE_SEPARATOR);
      return separatorAt === -1
        ? { encrypted: raw as OwnerKeyEncrypted, marker: null, raw }
        : {
            encrypted: raw.slice(separatorAt + 1) as OwnerKeyEncrypted,
            marker: raw.slice(0, separatorAt) as BlindIndex,
            raw,
          };
    });

/** Decrypt one entry back to its source + ticket token. */
const parseTokenEntry = async (
  line: OwnerKeyEncrypted,
  privateKey: CryptoKey,
): Promise<BookingToken> => {
  const decoded = await decryptWithOwnerKey(line, privateKey);
  return { source: TAG_SOURCE[decoded[0]!]!, token: decoded.slice(1) };
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
    [hash, nowMs(), await encryptTokenEntry(hash, source, ticketToken)],
  );
};

/** Record one visit and booking against a contact. The token marker guards the
 * whole write, so retrying after a lost database result changes nothing. */
export const recordBookingActivity: BookingActivityWriter = async (
  hash,
  source,
  ticketToken,
) => {
  const column = BOOKING_COLUMN[source];
  const marker = `${await tokenMarkerFor(hash, ticketToken)}${TOKEN_LINE_SEPARATOR}`;
  await execute(
    `INSERT INTO contact_preferences
       (contact_hash, last_activity, visits, ${column}, attendee_tokens_blob)
     VALUES (?, ?, 1, 1, ?)
     ON CONFLICT(contact_hash) DO UPDATE SET
       visits = visits + 1,
       ${column} = ${column} + 1,
       last_activity = excluded.last_activity,
       attendee_tokens_blob = attendee_tokens_blob || excluded.attendee_tokens_blob
     WHERE INSTR(attendee_tokens_blob, ?) = 0`,
    [hash, nowMs(), await encryptTokenEntry(hash, source, ticketToken), marker],
  );
};

/** Collect the contact hashes for the non-empty email and phone on an order. */
const orderContactHashes = (
  email: unknown,
  phone: unknown,
): Promise<string[]> => {
  const contacts: [ContactChannel, string][] = [];
  if (typeof email === "string" && email.trim()) {
    contacts.push(["email", email]);
  }
  if (typeof phone === "string" && phone.trim()) {
    contacts.push(["sms", phone]);
  }
  return Promise.all(
    contacts.map(([channel, value]) => contactHash(channel, value)),
  );
};

/** Run one effect against every contact identity on an order. */
const forEachOrderContact =
  (run: (hash: string) => Promise<void>) =>
  async (email: unknown, phone: unknown): Promise<void> => {
    await Promise.all((await orderContactHashes(email, phone)).map(run));
  };

/** Record one replay-safe visit and booking for every contact on an order. */
export const recordOrderActivity = (
  email: unknown,
  phone: unknown,
  source: BookingSource,
  ticketToken: string,
): Promise<void> =>
  forEachOrderContact((hash) =>
    recordBookingActivity(hash, source, ticketToken),
  )(email, phone);

/** Load a contact's encrypted token blob, or null when no row exists. */
const loadTokenBlob = async (hash: string): Promise<string | null> => {
  const row = await queryOne<{ attendee_tokens_blob: string }>(
    "SELECT attendee_tokens_blob FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );
  return row?.attendee_tokens_blob ?? null;
};

/** Split a loaded token blob, treating a missing or empty blob as no tokens. */
const tokenLinesFrom = (blob: string | null): StoredTokenLine[] =>
  blob ? splitTokenBlob(blob) : [];

/** Load a contact's token entries as stored lines. */
const loadTokenLines = async (hash: string): Promise<StoredTokenLine[]> =>
  tokenLinesFrom(await loadTokenBlob(hash));

/** Decrypt loaded token lines into source + ticket token pairs. */
const bookingTokensFrom = (
  lines: OwnerKeyEncrypted[],
  privateKey: CryptoKey,
): Promise<BookingToken[]> =>
  Promise.all(lines.map((line) => parseTokenEntry(line, privateKey)));

/** Read only the newest booked ticket tokens, decrypting no older entries. */
export const getRecentBookingTokens = async (
  hash: string,
  privateKey: CryptoKey,
  limit: number,
): Promise<BookingToken[]> => {
  if (limit <= 0) return [];
  return bookingTokensFrom(
    (await loadTokenLines(hash)).slice(-limit).map((line) => line.encrypted),
    privateKey,
  );
};

/** Remove the first entry for `ticketToken` from a contact's encrypted list. */
const removeBookingToken = async (
  hash: string,
  ticketToken: string,
  privateKey: CryptoKey,
): Promise<BookingSource | null> => {
  const marker = await tokenMarkerFor(hash, ticketToken);
  const match = (await loadTokenLines(hash)).find(
    (entry) => entry.marker === marker,
  );
  if (!match) return null;
  const removed = await parseTokenEntry(match.encrypted, privateKey);
  // Delete just this entry's ciphertext line in place. REPLACE operates on the
  // column's current value at write time, so a keyless checkout append that
  // lands after our read is preserved instead of overwritten by a stale rewrite.
  await execute(
    "UPDATE contact_preferences SET attendee_tokens_blob = REPLACE(attendee_tokens_blob, ?, ''), last_activity = ? WHERE contact_hash = ?",
    [`${match.raw}\n`, nowMs(), hash],
  );
  return removed.source;
};

/** Add the token when it is missing, preserving the existing list otherwise. */
const ensureBookingToken = async (
  hash: string,
  ticketToken: string,
  source: BookingSource,
  createMissingContact: boolean,
): Promise<void> => {
  const blob = await loadTokenBlob(hash);
  if (blob === null && !createMissingContact) return;
  const marker = await tokenMarkerFor(hash, ticketToken);
  if (tokenLinesFrom(blob).some((entry) => entry.marker === marker)) return;
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
  /** True when this sync is triggered by an attendee gaining its first real
   * booking (a placeholder edited to a real quantity). A missing contact row is
   * then created for an unchanged contact value so the booking links, rather
   * than skipped the way a routine unchanged edit skips an erased row. */
  firstRealBooking: boolean;
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
    changed || sync.firstRealBooking,
  );
};

/** Keep an attendee's ticket token under the contacts that currently own it. */
export const syncAttendeeContactTokens = async (
  sync: ContactTokenSync,
): Promise<void> => {
  await syncChannelToken("email", sync);
  await syncChannelToken("sms", sync);
};
