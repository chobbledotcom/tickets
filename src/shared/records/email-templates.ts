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
import { defineRecord, type WriteVerdict } from "#shared/rest/record.ts";
import { okResult } from "#shared/result.ts";
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
): Promise<WriteVerdict<EmailTemplateRow>> => {
  if (id !== null) {
    if ((await getRawEmailTemplate(id)) === null) return { kind: "not-found" };
    const sealed = await sealedTemplate(input);
    await updateEmailTemplate(id, sealed.subject, sealed.body);
    return { kind: "written", row: { id, subject: input.subject } };
  }
  const sealed = await sealedTemplate(input);
  const created = await insertEmailTemplate(sealed.subject, sealed.body);
  return { kind: "written", row: { id: created, subject: input.subject } };
};

export const emailTemplateRecord = defineRecord<
  EmailTemplateRow,
  EmailTemplateInput
>({
  activityName: "Template",
  deleteDestination: "emailTemplateDelete",
  getAll: () => Promise.resolve([]),
  list: "emails",
  load: async (id) => {
    const raw = await getRawEmailTemplate(id);
    if (raw === null) return null;
    const privateKey = await requireRequestPrivateKey();
    return {
      id,
      subject: await decryptWithOwnerKey(raw.subject, privateKey),
    };
  },
  logName: (input) => input.subject,
  nameOf: (template) => template.subject,
  rule: (input) => okResult(input),
  write: {
    create: (input) => saveTemplate(null, input),
    remove: async (id) => {
      const raw = await getRawEmailTemplate(id);
      if (raw === null) return { kind: "not-found" };
      await deleteEmailTemplate(id);
      return { kind: "deleted" };
    },
    update: (id, input) => saveTemplate(id, input),
  },
});
