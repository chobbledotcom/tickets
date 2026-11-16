/**
 * Raw storage for email templates.
 *
 * Subject and body are stored as owner-keypair-encrypted blobs — the same
 * approach used for bulk_email_draft in settings. Encryption and decryption
 * are handled at the route layer. This module only reads and writes the
 * sealed values as-is.
 */

import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import {
  allRowsNewestFirst,
  deleteRow,
  findRow,
  insertRow,
  updateRow,
} from "#db/record-table.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { bindFirst } from "#shared/fp-bind.ts";

export type RawEmailTemplate = DecodedRowOf<"email_templates">;

/** Every template, newest first (the admin templates list). */
export const getAllRawEmailTemplates = allRowsNewestFirst(
  tables.email_templates,
);

export const getRawEmailTemplate = (
  id: number,
): Promise<RawEmailTemplate | null> => findRow(tables.email_templates, id);

export const insertEmailTemplate = async (
  subject: OwnerKeyEncrypted,
  body: OwnerKeyEncrypted,
): Promise<number> =>
  (await insertRow(tables.email_templates, { body, subject })).id;

export const updateEmailTemplate = async (
  id: number,
  subject: OwnerKeyEncrypted,
  body: OwnerKeyEncrypted,
): Promise<void> => {
  await updateRow(tables.email_templates, id, { body, subject });
};

export const deleteEmailTemplate = bindFirst(deleteRow)(tables.email_templates);
