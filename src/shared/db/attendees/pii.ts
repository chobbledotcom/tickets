/**
 * PII blob encoding, encryption, and decryption for attendees.
 *
 * PII (name, email, phone, payment ID) is encrypted at rest using hybrid encryption:
 * - Encryption uses the public key (no authentication needed)
 * - Decryption requires the private key (only available to authenticated sessions)
 */

/* jscpd:ignore-start */
import { map } from "#fp";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import type {
  AttendeeInput,
  AttendeePii,
  EncryptedAttendeeData,
  EncryptInput,
  UpdateAttendeePIIInput,
} from "#shared/db/attendee-types.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";
import type { ContactInfo, PiiBlob } from "#shared/types.ts";
/* jscpd:ignore-end */

/** Current PII blob schema version */
export const PII_BLOB_VERSION = 1;

/** The five stored contact fields from an attendee write, with the optional
 * ones defaulted to "". Shared by the create result and the encryption input so
 * both read the same contact shape from one place. */
export const attendeeContactInfo = (input: AttendeeInput): ContactInfo => ({
  address: input.address ?? "",
  email: input.email,
  name: input.name,
  phone: input.phone ?? "",
  special_instructions: input.special_instructions ?? "",
});

/** Project one attendee write into the fields stored in its encrypted PII. */
export const attendeeEncryptionInput = (
  input: AttendeeInput,
  paymentId: string,
): EncryptInput => ({
  ...attendeeContactInfo(input),
  paymentId,
});

/** Build a PII blob JSON from contact fields. An unpinned latitude/longitude
 * ("") is left out of the JSON so blobs without a pin stay as small as before. */
export const buildPiiBlob = (info: AttendeePii): string =>
  JSON.stringify({
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
  } satisfies PiiBlob);

/** Parse a PII blob JSON back into contact fields (defaults v to 1 for pre-versioned blobs) */
export const parsePiiBlob = (json: string): PiiBlob => {
  const blob = JSON.parse(json) as PiiBlob;
  blob.v ??= PII_BLOB_VERSION;
  return blob;
};

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

/** The fields every freshly-built attendee echo carries with the same fixed
 * values: a new booking is un-checked-in, un-refunded, and location-less, and
 * the encrypted blob is never echoed back. Shared by the create result and the
 * committed-rows recovery read, so the two projections cannot drift. */
export const ATTENDEE_ECHO_DEFAULTS = {
  attachment_downloads: 0,
  checked_in: false,
  lat: "",
  lng: "",
  // Staging inserts its stage row after the attendee, and no echo consumer
  // reads the flag — the projected value comes from the read path.
  pending_checkout: 0,
  pii_blob: "",
  refunded: false,
  split_logistics_agents: false,
} as const;

/** Encrypt attendee fields into a PII blob, returning null if key not configured */
export const encryptAttendeeFields = async (
  input: EncryptInput,
  ticketToken: string,
): Promise<EncryptedAttendeeData | null> => {
  const publicKeyJwk = settings.publicKey;
  if (!publicKeyJwk) return null;

  // Bookings never carry a pinned location — lat/lng are admin-side only.
  const piiJson = buildPiiBlob({
    ...contactFields(input),
    lat: "",
    lng: "",
    payment_id: input.paymentId,
    ticket_token: ticketToken,
  });

  const [ticketTokenIndex, encryptedPiiBlob] = await Promise.all([
    computeTicketTokenIndex(ticketToken),
    encryptPiiBlob(piiJson, publicKeyJwk),
  ]);

  return {
    created: nowIso(),
    encryptedPiiBlob,
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
