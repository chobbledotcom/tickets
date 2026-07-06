/**
 * Raw storage for email templates.
 *
 * Subject and body are stored as owner-keypair-encrypted blobs — the same
 * approach used for bulk_email_draft in settings. Encryption and decryption
 * are handled at the route layer; this module only reads and writes opaque
 * TEXT values, so the table declares them as plain columns.
 */

import { countRows, queryAll } from "#shared/db/client.ts";
import { defineIdTable } from "#shared/db/define-id-table.ts";
import { col } from "#shared/db/table.ts";

export type RawEmailTemplate = { id: number; subject: string; body: string };
type RawEmailTemplateInput = { subject: string; body: string };

const emailTemplatesTable = defineIdTable<
  RawEmailTemplate,
  RawEmailTemplateInput
>("email_templates", {
  body: col.simple<string>(),
  id: col.generated<number>(),
  subject: col.simple<string>(),
});

/** Every template, newest first (the admin templates list). */
export const getAllRawEmailTemplates = (): Promise<RawEmailTemplate[]> =>
  queryAll("SELECT id, subject, body FROM email_templates ORDER BY id DESC");

export const getRawEmailTemplate = (
  id: number,
): Promise<RawEmailTemplate | null> => emailTemplatesTable.findById(id);

export const countEmailTemplates = (): Promise<number> =>
  countRows("email_templates");

export const insertEmailTemplate = async (
  subject: string,
  body: string,
): Promise<number> => (await emailTemplatesTable.insert({ body, subject })).id;

export const updateEmailTemplate = async (
  id: number,
  subject: string,
  body: string,
): Promise<void> => {
  await emailTemplatesTable.update(id, { body, subject });
};

export const deleteEmailTemplate = (id: number): Promise<void> =>
  emailTemplatesTable.deleteById(id);
