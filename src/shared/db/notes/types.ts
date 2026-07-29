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

import type {
  EnvKeyEncrypted,
  OwnerKeyEncrypted,
} from "#shared/crypto/sealed.ts";
import type { NoteEntity } from "./target.ts";

export type SystemNoteType = "system" | "owner";

/** A stored note with its `note` field opened up to plain text. */
export interface SystemNote {
  created: string;
  entity_id: number;
  entity_type: NoteEntity;
  id: number;
  note: string;
  type: SystemNoteType;
}

/** The row as stored, its `note` still sealed. Which sealing was used follows
 *  the note's kind, so a row is a choice between the two rather than a shape
 *  where either ciphertext might turn up under either kind. */
export type SystemNoteRow = Omit<SystemNote, "note" | "type"> &
  (
    | { type: "owner"; note: OwnerKeyEncrypted }
    | { type: "system"; note: EnvKeyEncrypted }
  );
