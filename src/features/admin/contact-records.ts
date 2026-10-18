/**
 * The attendee page's per-channel contact history loaders: the read-only
 * panel's email/phone records plus the HMAC link to each channel's editor.
 */

import { base64ToBase64Url } from "#crypto/utils.ts";
import {
  getContactRecordOrRepair,
  hashEmail,
  hashPhone,
} from "#db/contact-preferences.ts";
import { addPageImageUrls } from "#db/images.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type {
  ContactChannelData,
  ContactRecordsByChannel,
} from "#templates/admin/attendee-page.tsx";
import type { Attendee } from "#types";

/** No contact history on file for either channel. */
const EMPTY_CONTACT_RECORDS: ContactRecordsByChannel = {
  email: null,
  phone: null,
};

/** Load and decrypt one channel's contact record (null when no value on file).
 * Notes are owner-encrypted, so this needs the session private key. A corrupt/
 * undecryptable stats_blob for one contact must not take down the whole
 * attendee page. `getContactRecordOrRepair` surfaces it for repair and keeps
 * the channel with its surviving counts and (crucially) its /admin/history
 * link. The operator can then still open the editor and overwrite the bad
 * row. Dropping the channel here hides the only path to fix it. */
const loadChannelRecordOrRepair = getContactRecordOrRepair("contact history");
const loadChannelRecord = async (
  value: string,
  hashOf: (value: string) => Promise<string>,
  privateKey: CryptoKey,
): Promise<ContactChannelData | null> => {
  if (!value.trim()) return null;
  const hash = await hashOf(value);
  const record = await loadChannelRecordOrRepair(hash, privateKey);
  await addPageImageUrls([record.adminNotes]);
  return {
    hashParam: base64ToBase64Url(hash),
    record,
  };
};

/** Read the attendee's per-channel contact history for the read-only panel.
 * The private key is only needed (and only requested) when there is at least
 * one contact value to decrypt. An attendee with no email/phone therefore
 * never forces a key prompt. */
export const loadContactRecords = async (
  attendee: Attendee,
): Promise<ContactRecordsByChannel> => {
  if (!attendee.email.trim() && !attendee.phone.trim()) {
    return EMPTY_CONTACT_RECORDS;
  }
  const pk = await requireRequestPrivateKey();
  return {
    email: await loadChannelRecord(attendee.email, hashEmail, pk),
    phone: await loadChannelRecord(attendee.phone, hashPhone, pk),
  };
};
