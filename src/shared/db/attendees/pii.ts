/**
 * PII blob encoding, encryption, and decryption for attendees.
 *
 * PII (name, email, phone, payment ID) is encrypted at rest using hybrid encryption:
 * - Encryption uses the public key (no authentication needed)
 * - Decryption requires the private key (only available to authenticated sessions)
 */

import type { InValue } from "@libsql/client";
/* jscpd:ignore-start */
import * as v from "valibot";
import { hmacHash } from "#crypto/hashing.ts";
import { decryptWithOwnerKey, encryptWithOwnerKey } from "#crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { generateTicketToken } from "#crypto/utils.ts";
import type {
  AttendeePii,
  EncryptedAttendeeData,
  EncryptInput,
  UpdateAttendeePIIInput,
} from "#db/attendee-types.ts";
import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import type { DayRange } from "#db/capacity.ts";
import { inPlaceholders, queryAll, queryOne } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { map } from "#fp";
import { nowIso } from "#shared/now.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";
import type { ContactInfo, PiiBlob } from "#types";
/* jscpd:ignore-end */

/** Current PII blob schema version */
export const PII_BLOB_VERSION = 1;

const PiiBlobSchema: v.GenericSchema<unknown, PiiBlob> = v.strictObject({
  a: v.string(),
  e: v.string(),
  la: v.optional(v.string()),
  lo: v.optional(v.string()),
  n: v.string(),
  p: v.string(),
  pi: v.string(),
  s: v.string(),
  t: v.string(),
  v: v.optional(v.literal(PII_BLOB_VERSION), PII_BLOB_VERSION),
});
const piiBlobJson = defineStoredJson(PiiBlobSchema);

/** Build a PII blob JSON from contact fields. An unpinned latitude/longitude
 * ("") is left out of the JSON so blobs without a pin stay as small as before. */
export const buildPiiBlob = (info: AttendeePii): string =>
  piiBlobJson.write(
    {
      a: info.address,
      e: info.email,
      la: info.lat || undefined,
      lo: info.lng || undefined,
      n: info.name,
      p: info.phone,
      pi: info.payment_id,
      s: info.special_instructions,
      t: info.ticket_token,
      v: PII_BLOB_VERSION,
    },
    "attendees.pii_blob",
  );

/** Parse a PII blob JSON back into contact fields (defaults v to 1 for pre-versioned blobs) */
export const parsePiiBlob = (json: string): PiiBlob =>
  piiBlobJson.read(json, "attendees.pii_blob");

/** Encrypt a PII blob JSON string with the public key */
export const encryptPiiBlob = (
  blobJson: string,
  publicKeyJwk: string,
): Promise<OwnerKeyEncrypted> => encryptWithOwnerKey(blobJson, publicKeyJwk);

/** Decrypt a PII blob and extract all contact fields */
export const decryptPiiBlob = async (
  encrypted: OwnerKeyEncrypted,
  privateKey: CryptoKey,
  paidListing: boolean,
): Promise<UpdateAttendeePIIInput> => {
  const json = await decryptWithOwnerKey(encrypted, privateKey);
  const blob = parsePiiBlob(json);
  return {
    address: blob.a,
    email: blob.e,
    lat: blob.la ?? "",
    lng: blob.lo ?? "",
    name: blob.n,
    payment_id: paidListing ? blob.pi : "",
    phone: blob.p,
    special_instructions: blob.s,
    ticket_token: blob.t,
  };
};

/** The raw attendee columns the decrypt step reads and coerces. `price_paid`
 * and `refunded` are optional because a field-selected read may leave them out
 * (see {@link file://./select.ts}); the decrypt then leaves them out too rather
 * than coercing an absent column into `"undefined"` / `false`. */
export type RawAttendeeRow = {
  pii_blob: OwnerKeyEncrypted | "";
  checked_in: number | boolean;
  split_logistics_agents: number | boolean;
  price_paid?: number | string;
  refunded?: number | boolean;
};

/** A decrypted attendee row: the raw row with its PII overlaid and its
 * booleans/price coerced, keeping exactly whichever optional money fields the
 * read selected. `DecryptedAttendeeRow<Attendee>` is the full `Attendee`. */
export type DecryptedAttendeeRow<R extends RawAttendeeRow> = Omit<
  R,
  keyof AttendeePii | "checked_in" | "split_logistics_agents"
> &
  AttendeePii & {
    checked_in: boolean;
    split_logistics_agents: boolean;
  } & (R extends { price_paid: number | string }
    ? { price_paid: string }
    : unknown) &
  (R extends { refunded: number | boolean } ? { refunded: boolean } : unknown);

/**
 * Decrypt attendee fields from the PII blob.
 * Requires migration to be complete (admin is gated behind migration).
 * When paidListing is false, payment_id and refunded are skipped.
 *
 * `price_paid` and `refunded` are coerced only when the read actually selected
 * them: a table read that skipped their (expensive) subqueries carries neither
 * column, and `String(undefined)` / `Boolean(undefined)` would fabricate a
 * bogus value.
 */
export const decryptAttendeeFields = async <R extends RawAttendeeRow>(
  row: R,
  privateKey: CryptoKey,
  paidListing = true,
): Promise<DecryptedAttendeeRow<R>> => {
  // Rows reaching here were read from the database, where pii_blob is always
  // stored owner-key ciphertext; the "" sentinel exists only on just-created
  // in-memory echoes, which are never decrypted.
  const pii = await decryptPiiBlob(
    row.pii_blob as OwnerKeyEncrypted,
    privateKey,
    paidListing,
  );
  return {
    ...row,
    ...pii,
    checked_in: Boolean(row.checked_in),
    // Convert to proper types — value may be integer (from SQL) or boolean (from buildAttendeeView)
    ...("price_paid" in row ? { price_paid: String(row.price_paid) } : {}),
    ...("refunded" in row
      ? { refunded: paidListing ? Boolean(row.refunded) : false }
      : {}),
    split_logistics_agents: Boolean(row.split_logistics_agents),
  } as DecryptedAttendeeRow<R>;
};

/** Extract ContactInfo fields from an object */
export const contactFields = ({
  name,
  email,
  phone,
  address,
  special_instructions,
}: ContactInfo): ContactInfo => ({
  address,
  email,
  name,
  phone,
  special_instructions,
});

/** Encrypt attendee fields into a PII blob. */
export const encryptAttendeeFields = async (
  input: EncryptInput,
  ticketToken = generateTicketToken(),
): Promise<EncryptedAttendeeData> => {
  // Bookings never carry a pinned location — lat/lng are admin-side only.
  const piiJson = buildPiiBlob({
    ...contactFields(input),
    lat: "",
    lng: "",
    payment_id: input.paymentId,
    ticket_token: ticketToken,
  });

  const [ticketTokenIndex, encryptedPiiBlob] = await Promise.all([
    hmacHash(ticketToken),
    encryptPiiBlob(piiJson, settings.publicKey),
  ]);

  return {
    created: nowIso(),
    encryptedPiiBlob,
    piiPaymentSessionId: input.paymentId === "" ? "" : null,
    ticketToken,
    ticketTokenIndex,
  };
};

/**
 * Decrypt a list of raw attendees (all fields).
 * Used when attendees are fetched via batch query.
 */
export const decryptAttendees = <R extends RawAttendeeRow>(
  rows: R[],
  privateKey: CryptoKey,
  paidListing = true,
): Promise<DecryptedAttendeeRow<R>[]> =>
  Promise.all(
    map((row: R) => decryptAttendeeFields(row, privateKey, paidListing))(rows),
  );

/**
 * Decrypt a single raw attendee, handling null input.
 * Used when attendee is fetched via batch query.
 */
export const decryptAttendeeOrNull = <R extends RawAttendeeRow>(
  row: R | null,
  privateKey: CryptoKey,
): Promise<DecryptedAttendeeRow<R> | null> =>
  row ? decryptAttendeeFields(row, privateKey) : Promise.resolve(null);

/** Keeps only attendees who have at least one real (quantity > 0) booking line —
 * a no-quantity-only placeholder (interested/cancelled) has no valid ticket URL,
 * so it is never part of an email audience. Shared by every pii_blob read. */
const HAS_REAL_LINE = `EXISTS (
       SELECT 1 FROM listing_attendees
       WHERE attendee_id = attendees.id AND quantity > 0
     )`;

/** Select the encrypted pii_blob of each real-audience attendee (an
 * ATTENDEE_KIND row with a real line) matching one extra narrowing clause, then
 * return just the blobs. The bulk-email audience reads all read and unwrap the
 * blob the same way; they differ only in how they pick which attendees match. */
const selectAudiencePiiBlobs = async (
  extraWhere: string,
  args?: InValue[],
): Promise<OwnerKeyEncrypted[]> => {
  const rows = await queryAll<{ pii_blob: OwnerKeyEncrypted }>(
    `SELECT pii_blob FROM attendees
     WHERE kind = '${ATTENDEE_KIND}' AND ${extraWhere}`,
    args,
  );
  return rows.map((r) => r.pii_blob);
};

/**
 * Get every attendee's encrypted PII blob (one row per attendee).
 * Used to resolve bulk-email recipient lists, where only the email inside each
 * blob is needed. De-duplication of addresses happens after decryption.
 */
export const getAllAttendeePiiBlobs = (): Promise<OwnerKeyEncrypted[]> =>
  selectAudiencePiiBlobs(HAS_REAL_LINE);

/**
 * Get the encrypted PII blobs for attendees booked onto any of the given
 * listings (one row per attendee, even if booked onto several of them).
 * Returns an empty array when no listing IDs are supplied.
 */
export const getAttendeePiiBlobsForListings = (
  listingIds: number[],
): Promise<OwnerKeyEncrypted[]> =>
  listingIds.length === 0
    ? Promise.resolve([])
    : // quantity > 0: only attendees with a real line on these listings — a
      // no-quantity sentinel line doesn't make someone an "attendee of X".
      selectAudiencePiiBlobs(
        `id IN (
       SELECT DISTINCT attendee_id FROM listing_attendees
       WHERE listing_id IN (${inPlaceholders(listingIds)}) AND quantity > 0
     )`,
        listingIds,
      );

/**
 * Get the encrypted PII blobs for attendees whose booking on one listing covers
 * a given day. A booking spanning several days covers each of them, so a stay
 * from Friday to Sunday answers to Saturday as well as to its own first day.
 * Uses the same half-open overlap predicate as the capacity checks, so the
 * people a day's message reaches are the people that day counts.
 */
export const getAttendeePiiBlobsForListingDay = (
  listingId: number,
  day: DayRange,
): Promise<OwnerKeyEncrypted[]> =>
  selectAudiencePiiBlobs(
    `id IN (
       SELECT DISTINCT listingAttendee.attendee_id
       FROM listing_attendees AS listingAttendee
       WHERE listingAttendee.listing_id = ? AND listingAttendee.quantity > 0
         AND listingAttendee.start_at < ? AND listingAttendee.end_at > ?
     )`,
    [listingId, day.endAt, day.startAt],
  );

/**
 * Get the encrypted PII blob for the attendee identified by a plaintext ticket
 * token. Used to resolve a single-attendee bulk-email recipient. Ticket tokens
 * are unique, so this matches at most one attendee; returns null when the token
 * matches none, so a stale or unknown token resolves to no recipient rather
 * than erroring.
 */
export const getAttendeePiiBlobForToken = async (
  token: string,
): Promise<OwnerKeyEncrypted | null> => {
  const tokenIndex = await hmacHash(token);
  // Apply the real-line guard: an all-ghost (no-quantity-only) attendee has no
  // valid ticket URL, so the single-attendee bulk-email target resolves to no
  // recipient (a genuine one-off transactional mail would be a separate path).
  const row = await queryOne<{ pii_blob: OwnerKeyEncrypted }>(
    `SELECT pii_blob FROM attendees
     WHERE ticket_token_index = ?
       AND kind = '${ATTENDEE_KIND}'
       AND EXISTS (
         SELECT 1 FROM listing_attendees
         WHERE attendee_id = attendees.id AND quantity > 0
       )
     LIMIT 1`,
    [tokenIndex],
  );
  return row ? row.pii_blob : null;
};
