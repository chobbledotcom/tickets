/**
 * Raw storage for email templates.
 *
 * Subject and body are stored as owner-keypair-encrypted blobs — the same
 * approach used for bulk_email_draft in settings. Encryption and decryption
 * are handled at the route layer; this module only reads and writes the sealed
 * values as-is, so the table declares them as simple OwnerKeyEncrypted columns.
 */

import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { countRows } from "#shared/db/client.ts";
import { defineIdTable } from "#shared/db/define-id-table.ts";
import { col } from "#shared/db/table.ts";

export type RawEmailTemplate = {
  id: number;
  subject: OwnerKeyEncrypted;
  body: OwnerKeyEncrypted;
};
type RawEmailTemplateInput = {
  subject: OwnerKeyEncrypted;
  body: OwnerKeyEncrypted;
};

const emailTemplatesTable = defineIdTable<
  RawEmailTemplate,
  RawEmailTemplateInput
>("email_templates", {
  body: col.simple<OwnerKeyEncrypted>(),
  id: col.generated<number>(),
  subject: col.simple<OwnerKeyEncrypted>(),
});

/** Every template, newest first (the admin templates list). */
export const getAllRawEmailTemplates = (): Promise<RawEmailTemplate[]> =>
  emailTemplatesTable.read
    .pick(["id", "subject", "body"])
    .many({}, { order: "id DESC" });

export const getRawEmailTemplate = (
  id: number,
): Promise<RawEmailTemplate | null> => emailTemplatesTable.read.one({ id });

export const countEmailTemplates = (): Promise<number> =>
  countRows("email_templates");

export const insertEmailTemplate = async (
  subject: OwnerKeyEncrypted,
  body: OwnerKeyEncrypted,
): Promise<number> => (await emailTemplatesTable.insert({ body, subject })).id;

export const updateEmailTemplate = async (
  id: number,
  subject: OwnerKeyEncrypted,
  body: OwnerKeyEncrypted,
): Promise<void> => {
  await emailTemplatesTable.update(id, { body, subject });
};

export const deleteEmailTemplate = (id: number): Promise<void> =>
  emailTemplatesTable.deleteById(id);
