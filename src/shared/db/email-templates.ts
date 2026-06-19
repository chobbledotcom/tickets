/**
 * Raw storage for email templates.
 *
 * Subject and body are stored as owner-keypair-encrypted blobs — the same
 * approach used for bulk_email_draft in settings. Encryption and decryption
 * are handled at the route layer; this module only reads and writes opaque
 * TEXT values.
 */

import { countRows, execute, queryAll, queryOne } from "#shared/db/client.ts";

export type RawEmailTemplate = { id: number; subject: string; body: string };

export const getAllRawEmailTemplates = (): Promise<RawEmailTemplate[]> =>
  queryAll("SELECT id, subject, body FROM email_templates ORDER BY id DESC");

export const getRawEmailTemplate = (
  id: number,
): Promise<RawEmailTemplate | null> =>
  queryOne("SELECT id, subject, body FROM email_templates WHERE id = ?", [id]);

export const countEmailTemplates = (): Promise<number> =>
  countRows("email_templates");

/* jscpd:ignore-start */
export const insertEmailTemplate = async (
  subject: string,
  body: string,
): Promise<number> => {
  const result = await execute(
    "INSERT INTO email_templates (subject, body) VALUES (?, ?)",
    [subject, body],
  );
  return Number(result.lastInsertRowid);
};

export const updateEmailTemplate = async (
  id: number,
  subject: string,
  body: string,
): Promise<void> => {
  await execute(
    "UPDATE email_templates SET subject = ?, body = ? WHERE id = ?",
    [subject, body, id],
  );
};

export const deleteEmailTemplate = async (id: number): Promise<void> => {
  await execute("DELETE FROM email_templates WHERE id = ?", [id]);
};
/* jscpd:ignore-end */
