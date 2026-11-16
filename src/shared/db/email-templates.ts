/**
 * Raw storage for email templates.
 *
 * Subject and body are stored as owner-keypair-encrypted blobs — the same
 * approach used for bulk_email_draft in settings. Encryption and decryption
 * are handled at the route layer. This module only reads and writes the
 * sealed values as-is.
 */

import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { readRows } from "#db/read.ts";
import { deleteRow, findRow, insertRow, updateRow } from "#db/record-table.ts";
import { desc } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";

export type RawEmailTemplate = DecodedRowOf<"email_templates">;

/** Every template, newest first (the admin templates list). */
export const getAllRawEmailTemplates = (): Promise<RawEmailTemplate[]> =>
  readRows(
    from(tables.email_templates)
      .orderBy((template) => [desc(template.id)])
      .everyColumn(),
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

export const deleteEmailTemplate = (id: number): Promise<void> =>
  deleteRow(tables.email_templates, id);
