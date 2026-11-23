/**
 * What a note is, stored and unstored.
 *
 * Two note kinds share one table and differ only in how the text is sealed:
 *  - `system` — written by the app itself (e.g. the refunded-but-stored booking
 *    warning). Sealed with the symmetric DB_ENCRYPTION_KEY so a path with no
 *    logged-in owner can both write it and read it back. Kept free of personal
 *    details by convention.
 *  - `owner` — written by an operator. Sealed with the owner public key, so it
 *    can be written without a session but read only with the owner private key.
 */

import type { EnvKeyEncrypted, OwnerKeyEncrypted } from "#crypto/sealed.ts";
import type { NoteEntity } from "./target.ts";

/** Which key seals a note: the app's key, or the owner's. */
export const SYSTEM_NOTE_TYPES = ["system", "owner"] as const;

export type SystemNoteType = (typeof SYSTEM_NOTE_TYPES)[number];

/** App-written note purposes whose lifecycle is decided from stored facts,
 * never by opening the note text. */
export type SystemNotePurpose =
  | "checkout_bundle_lost"
  | "refund_confirmation"
  | "refund_unreturned"
  | "scan_over_admission";

/** The indexed name of one app-written note. The key is an opaque identity,
 * such as a payment-reference blind index or refund-confirmation identity. */
export type SystemNoteName = {
  key: string;
  purpose: SystemNotePurpose;
};

/** A stored note with its `note` field opened up to plain text. */
export interface SystemNote {
  created: string;
  entityId: number;
  entityType: NoteEntity;
  id: number;
  note: string;
  type: SystemNoteType;
}

/** The row as stored, its `note` still sealed. The kind of the note says
 *  which key sealed it: the owner key for "owner", the env key for "system". */
export type SystemNoteRow = Omit<SystemNote, "note"> & {
  systemName: string | null;
  note: OwnerKeyEncrypted | EnvKeyEncrypted;
};
