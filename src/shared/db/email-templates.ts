/**
 * Raw storage for email templates.
 *
 * Subject and body are stored as owner-keypair-encrypted blobs — the same
 * approach used for bulk_email_draft in settings. Encryption and decryption
 * are handled at the route layer; this module only reads and writes opaque
 * TEXT values.
 */

import { getDb, queryAll, queryOne } from "#shared/db/client.ts";

export type RawEmailTemplate = { id: number; subject: string; body: string };

export const getAllRawEmailTemplates = (): Promise<RawEmailTemplate[]> =>
  queryAll("SELECT id, subject, body FROM email_templates ORDER BY id DESC");

export const getRawEmailTemplate = (
  id: number,
): Promise<RawEmailTemplate | null> =>
  queryOne("SELECT id, subject, body FROM email_templates WHERE id = ?", [id]);

export const countEmailTemplates = async (): Promise<number> => {
  const row = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM email_templates",
    [],
  );
  return row?.n ?? 0;
};

export const insertEmailTemplate = async (
  subject: string,
  body: string,
): Promise<number> => {
  const result = await getDb().execute({
    args: [subject, body],
    sql: "INSERT INTO email_templates (subject, body) VALUES (?, ?)",
  });
  return Number(result.lastInsertRowid);
};

export const updateEmailTemplate = async (
  id: number,
  subject: string,
  body: string,
): Promise<void> => {
  await getDb().execute({
    args: [subject, body, id],
    sql: "UPDATE email_templates SET subject = ?, body = ? WHERE id = ?",
  });
};

export const deleteEmailTemplate = async (id: number): Promise<void> => {
  await getDb().execute({
    args: [id],
    sql: "DELETE FROM email_templates WHERE id = ?",
  });
};
