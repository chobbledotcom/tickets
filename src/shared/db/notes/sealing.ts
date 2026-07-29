/**
 * Sealing a note's text, and opening it back up.
 *
 * The two note kinds seal differently (see ./types.ts), so each way of sealing
 * is named once here and everything else works in terms of a sealed note.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import type {
  EnvKeyEncrypted,
  OwnerKeyEncrypted,
} from "#shared/crypto/sealed.ts";
import { settings } from "#shared/db/settings.ts";
import type { SystemNote, SystemNoteRow, SystemNoteType } from "./types.ts";

type SealedNote = OwnerKeyEncrypted | EnvKeyEncrypted;

/** How each kind of note is sealed. A new kind is a new entry here, and the
 *  compiler asks for it everywhere the kinds are handled. */
const SEAL_AS: Record<SystemNoteType, (note: string) => Promise<SealedNote>> = {
  owner: (note) => encryptWithOwnerKey(note, settings.publicKey),
  system: (note) => encrypt(note),
};

export const sealNote = (
  type: SystemNoteType,
  note: string,
): Promise<SealedNote> => SEAL_AS[type](note);

/**
 * Open one note's text. We do not guard this: a failure here can only mean the
 * data key itself is broken — in which case the record's own personal details
 * would not open either and the page never renders — so a placeholder would
 * hide a whole-system failure behind a branch nothing can reach. Let it throw.
 */
export const openNote = async (
  row: SystemNoteRow,
  privateKey: CryptoKey,
): Promise<SystemNote> => ({
  ...row,
  note: await openText(row, privateKey),
});

const openText = (
  row: SystemNoteRow,
  privateKey: CryptoKey,
): Promise<string> =>
  row.type === "owner"
    ? decryptWithOwnerKey(row.note, privateKey)
    : decrypt(row.note);

/** Open a batch of note rows, keeping their order. */
export const openNotes = (
  rows: SystemNoteRow[],
  privateKey: CryptoKey,
): Promise<SystemNote[]> =>
  Promise.all(rows.map((row) => openNote(row, privateKey)));
