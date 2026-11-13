/**
 * The bulk-email template record. It holds the encrypted subject and body and
 * the save command that stores both. Its read decrypts the subject for the
 * delete page.
 */

import { decryptWithOwnerKey, encryptWithOwnerKey } from "#crypto/hybrid.ts";
import {
  deleteEmailTemplate,
  getRawEmailTemplate,
  insertEmailTemplate,
  updateEmailTemplate,
} from "#db/email-templates.ts";
import { settings } from "#db/settings.ts";
import {
  defineRecord,
  type Missing,
  type RecordShapeOf,
  type Written,
} from "#shared/rest/record.ts";
import { deleteIfPresent } from "#shared/rest/record-command.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";

export type EmailTemplateRow = { id: number; subject: string };
export type EmailTemplateInput = { body: string; subject: string };

/** Encrypt one template's subject and body with the owner public key. */
const sealedTemplate = async (input: EmailTemplateInput) => ({
  body: await encryptWithOwnerKey(input.body, settings.publicKey),
  subject: await encryptWithOwnerKey(input.subject, settings.publicKey),
});

const saveTemplate = async (
  id: number | null,
  input: EmailTemplateInput,
): Promise<Written<EmailTemplateRow> | Missing> => {
  if (id !== null && (await getRawEmailTemplate(id)) === null) {
    return { kind: "not-found" };
  }
  const sealed = await sealedTemplate(input);
  const writtenId =
    id ?? (await insertEmailTemplate(sealed.subject, sealed.body));
  if (id !== null) await updateEmailTemplate(id, sealed.subject, sealed.body);
  return { kind: "written", row: { id: writtenId, subject: input.subject } };
};

/** Decrypt one template's subject for the delete page, or null when it is
 *  gone. */
const templateSubjectOrNull = async (id: number): Promise<string | null> => {
  const raw = await getRawEmailTemplate(id);
  if (raw === null) return null;
  return decryptWithOwnerKey(raw.subject, await requireRequestPrivateKey());
};

export const emailTemplateRecord = defineRecord<
  RecordShapeOf<EmailTemplateRow, EmailTemplateInput>
>()({
  activityName: "Template",
  getAll: () => Promise.resolve([]),
  load: async (id) => {
    const subject = await templateSubjectOrNull(id);
    return subject === null ? null : { id, subject };
  },
  logName: (input) => input.subject,
  nameLabel: "bulk_email.name_label",
  nameOf: (template) => template.subject,
  surface: { deleteDestination: "emailTemplateDelete", list: "emails" },
  write: {
    create: (input) => saveTemplate(null, input),
    remove: (id) =>
      deleteIfPresent(id, {
        destroy: () => deleteEmailTemplate(id),
        load: getRawEmailTemplate,
      }),
    update: (id, input) => saveTemplate(id, input),
  },
});
