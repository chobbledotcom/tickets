/**
 * PII blob encoding, encryption, and decryption for attendees.
 *
 * PII (name, email, phone, payment ID) is encrypted at rest using hybrid encryption:
 * - Encryption uses the public key (no authentication needed)
 * - Decryption requires the private key (only available to authenticated sessions)
 */

import { map } from "#fp";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import { generateTicketToken } from "#shared/crypto/utils.ts";
import type {
  EncryptedAttendeeData,
  EncryptInput,
  UpdateAttendeePIIInput,
} from "#shared/db/attendee-types.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";
import type { Attendee, ContactInfo, PiiBlob } from "#shared/types.ts";

/** Current PII blob schema version */
export const PII_BLOB_VERSION = 1;

/** Build a PII blob JSON from contact fields */
export const buildPiiBlob = (
  info: ContactInfo & { payment_id: string; ticket_token: string },
): string =>
  JSON.stringify({
    a: info.address,
    e: info.email,
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
): Promise<string> => encryptWithOwnerKey(blobJson, publicKeyJwk);

/** Decrypt a PII blob and extract all contact fields */
export const decryptPiiBlob = async (
  encrypted: string,
  privateKey: CryptoKey,
  paidListing: boolean,
): Promise<UpdateAttendeePIIInput> => {
  const json = await decryptWithOwnerKey(encrypted, privateKey);
  const blob = parsePiiBlob(json);
  return {
    address: blob.a,
    email: blob.e,
    name: blob.n,
    payment_id: paidListing ? blob.pi : "",
    phone: blob.p,
    special_instructions: blob.s,
    ticket_token: blob.t,
  };
};

/**
 * Decrypt attendee fields from the PII blob.
 * Requires migration to be complete (admin is gated behind migration).
 * When paidListing is false, payment_id and refunded are skipped.
 */
export const decryptAttendeeFields = async (
  row: Attendee,
  privateKey: CryptoKey,
  paidListing = true,
): Promise<Attendee> => {
  const pii = await decryptPiiBlob(row.pii_blob, privateKey, paidListing);
  return {
    ...row,
    ...pii,
    checked_in: Boolean(row.checked_in),
    // Convert to proper types — value may be integer (from SQL) or boolean (from buildAttendeeView)
    price_paid: String(row.price_paid),
    refunded: paidListing ? Boolean(row.refunded) : false,
    split_logistics_agents: Boolean(row.split_logistics_agents),
  };
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

/** Encrypt attendee fields into a PII blob, returning null if key not configured */
export const encryptAttendeeFields = async (
  input: EncryptInput,
): Promise<EncryptedAttendeeData | null> => {
  const publicKeyJwk = settings.publicKey;
  if (!publicKeyJwk) return null;

  const ticketToken = generateTicketToken();
  const piiJson = buildPiiBlob({
    ...contactFields(input),
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
export const decryptAttendees = (
  rows: Attendee[],
  privateKey: CryptoKey,
  paidListing = true,
): Promise<Attendee[]> =>
  Promise.all(
    map((row: Attendee) => decryptAttendeeFields(row, privateKey, paidListing))(
      rows,
    ),
  );

/**
 * Decrypt a single raw attendee, handling null input.
 * Used when attendee is fetched via batch query.
 */
export const decryptAttendeeOrNull = (
  row: Attendee | null,
  privateKey: CryptoKey,
): Promise<Attendee | null> =>
  row ? decryptAttendeeFields(row, privateKey) : Promise.resolve(null);
