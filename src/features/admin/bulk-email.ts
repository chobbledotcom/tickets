/**
 * Bulk email routes — compose, preview, send, and template management.
 * Owner-only.
 *
 * Flow: compose (GET) → preview (POST saves a draft, redirects) → preview
 * (GET renders the saved draft) → send (POST). The draft is persisted in
 * settings so the preview redirect can carry a Markdown body too large for a
 * flash cookie, and so the send step re-reads exactly what was previewed.
 *
 * Templates: saved reusable subject/body pairs encrypted with the owner
 * keypair. The compose page lists them in a <details> block; clicking one
 * reloads the compose page with ?template=N to pre-fill the fields. The save
 * button (formaction="/admin/emails/templates") creates or updates a template.
 */

import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import {
  type AuthSession,
  OWNER_FORM,
  requireOwnerOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  type BulkEmailTarget,
  buildBulkPayload,
  buildMailtoLink,
  contactFrequencySummary,
  describeTarget,
  parseDraft,
  resolveRecipientEmails,
  serializeDraft,
  summarizeProviderResponse,
  targetAllowsEmpty,
  targetComposeControl,
  targetComposeCopy,
  targetFromForm,
  targetFromQuery,
  targetIsSingleRecipient,
  targetLogListingId,
  targetQuery,
  validateDraftInput,
} from "#shared/bulk-email.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
} from "#shared/crypto/keys.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  getContactCounts,
  getUnsubscribedHashSet,
  hashEmail,
  recordContacts,
} from "#shared/db/contact-preferences.ts";
import {
  countEmailTemplates,
  deleteEmailTemplate,
  getAllRawEmailTemplates,
  getRawEmailTemplate,
  insertEmailTemplate,
  updateEmailTemplate,
} from "#shared/db/email-templates.ts";
import { settings } from "#shared/db/settings.ts";
import {
  EMAIL_PROVIDER_LABELS,
  type EmailConfig,
  getEmailConfig,
  sendBulkEmails,
} from "#shared/email.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MAX_EMAIL_TEMPLATES } from "#shared/limits.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { ok } from "#shared/response.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";
import {
  bulkEmailComposePage,
  bulkEmailPreviewPage,
  bulkEmailTemplateDeletePage,
} from "#templates/admin/bulk-email.tsx";

const COMPOSE_PATH = "/admin/emails";
const PREVIEW_PATH = "/admin/emails/preview";

/** Whether the owner's *own* provider can send bulk, plus a reason if not. */
type BulkAvailability = {
  canBulkSend: boolean;
  disabledReason: string;
  config: EmailConfig | null;
};

const getBulkAvailability = (): BulkAvailability => {
  const config = getEmailConfig();
  return config
    ? { canBulkSend: true, config, disabledReason: "" }
    : {
        canBulkSend: false,
        config: null,
        disabledReason:
          "You haven't configured your own email provider, so the system won't send bulk email for you. Sending marketing from a shared address risks the whole platform's deliverability.",
      };
};

/** Recipients + the private key used + the owner's bulk-send availability. */
const loadSendContext = async (
  target: BulkEmailTarget,
): Promise<
  { privateKey: CryptoKey; recipients: string[] } & BulkAvailability
> => {
  const privateKey = await requireRequestPrivateKey();
  return {
    privateKey,
    recipients: await resolveRecipientEmails(target, privateKey),
    ...getBulkAvailability(),
  };
};

/** Hash a list of recipient emails (parallel). */
const hashAll = (emails: string[]): Promise<string[]> =>
  Promise.all(emails.map((e) => hashEmail(e)));

/** Decrypt and parse the saved draft using the owner's private key. */
const parseSavedDraft = async (
  privateKey: CryptoKey,
): Promise<ReturnType<typeof parseDraft>> => {
  const raw = settings.bulkEmailDraft;
  if (!raw) return null;
  return parseDraft(await decryptWithOwnerKey(raw, privateKey));
};

/** Serialize and encrypt a draft using the owner's public key. */
const saveDraft = async (
  draft: Parameters<typeof serializeDraft>[0],
): Promise<void> => {
  const encrypted = await encryptWithOwnerKey(
    serializeDraft(draft),
    settings.publicKey,
  );
  await settings.update.bulkEmailDraft(encrypted);
};

/** Wrap an owner-only page builder: gate on owner, record the flash's target
 * form (so a matching CsrfForm renders it inline), then build. The flash itself
 * is rendered by the targeted form or the Layout backstop — not threaded here. */
const ownerEmailPage =
  (build: (request: Request, session: AuthSession) => Promise<Response>) =>
  (request: Request): Promise<Response> =>
    requireOwnerOr(request, (session) => {
      applyFlash(request);
      return build(request, session);
    });

/** Split recipients into those who'll be sent to and a skipped (unsubscribed) count. */
const partitionRecipients = async (
  recipients: string[],
  marketing: boolean,
): Promise<{ sendable: string[]; skipped: number }> => {
  if (!marketing) return { sendable: recipients, skipped: 0 };
  const unsubscribed = await getUnsubscribedHashSet();
  const sendable: string[] = [];
  let skipped = 0;
  for (const email of recipients) {
    if (unsubscribed.has(await hashEmail(email))) skipped++;
    else sendable.push(email);
  }
  return { sendable, skipped };
};

/** Decrypt all template subjects for listing in the compose page. */
const decryptTemplateSubjects = async (
  privateKey: CryptoKey,
): Promise<{ id: number; subject: string }[]> => {
  const raw = await getAllRawEmailTemplates();
  return Promise.all(
    raw.map(async (t) => ({
      id: t.id,
      subject: await decryptWithOwnerKey(t.subject, privateKey),
    })),
  );
};

/** GET /admin/emails — compose form. */
const handleComposeGet = ownerEmailPage(async (request, session) => {
  const params = new URL(request.url).searchParams;
  const target = await targetFromQuery(params);
  if (!target) return notFoundResponse();
  const { recipients, privateKey, canBulkSend, disabledReason } =
    await loadSendContext(target);
  // A listing or attendee target with no emailable recipient (an unknown
  // attendee token, or nobody with an email on file) has nothing to send to —
  // treat it as not found rather than rendering an empty compose page. Named
  // audiences are allowed to be empty (they may fill up later).
  if (!targetAllowsEmpty(target) && recipients.length === 0) {
    return notFoundResponse();
  }
  const { targetLabel } = await describeTarget(target, recipients);
  const templates = await decryptTemplateSubjects(privateKey);

  const templateParam = params.get("template");
  const selectedTemplateId = templateParam
    ? parsePositiveIntId(templateParam)
    : null;
  let draft = await parseSavedDraft(privateKey);

  if (selectedTemplateId !== null) {
    const raw = await getRawEmailTemplate(selectedTemplateId);
    if (raw) {
      draft = {
        body: await decryptWithOwnerKey(raw.body, privateKey),
        marketing: draft?.marketing ?? false,
        subject: await decryptWithOwnerKey(raw.subject, privateKey),
        target,
      };
    }
  }

  return htmlResponse(
    bulkEmailComposePage(session, {
      canBulkSend,
      control: targetComposeControl(target),
      copy: targetComposeCopy(target),
      disabledReason,
      draft,
      recipientCount: recipients.length,
      selectedTemplateId,
      single: targetIsSingleRecipient(target),
      targetLabel,
      templateLinkBase: `${COMPOSE_PATH}${targetQuery(target)}`,
      templates,
    }),
  );
});

type ValidatedEmailForm = {
  target: BulkEmailTarget;
  subject: string;
  body: string;
  marketing: boolean;
};

/** Validate the target and message fields from a compose form, returning a
 * redirect Response on failure or the extracted fields on success. */
const validateFormBody = async (
  form: FormParams,
): Promise<Response | ValidatedEmailForm> => {
  const target = await targetFromForm(form);
  if (!target) {
    return errorRedirect(COMPOSE_PATH, "That listing no longer exists.");
  }
  const validation = validateDraftInput({
    body: form.getString("body"),
    marketing: form.get("marketing") === "1",
    subject: form.getString("subject"),
    target,
  });
  if (!validation.valid) {
    return errorRedirect(
      `${COMPOSE_PATH}${targetQuery(target)}`,
      validation.error,
      "bulk-email",
    );
  }
  return {
    body: validation.draft.body,
    marketing: validation.draft.marketing,
    subject: validation.draft.subject,
    target,
  };
};

/** POST /admin/emails/preview — validate, persist the draft, redirect to preview. */
/* jscpd:ignore-start */
const handlePreviewPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const result = await validateFormBody(form);
    if (result instanceof Response) return result;
    await saveDraft({ ...result });
    return ok(PREVIEW_PATH, "Review your email below before sending.");
  });
/* jscpd:ignore-end */

/** GET /admin/emails/preview — render the saved draft for confirmation. */
const handlePreviewGet = ownerEmailPage(async (_request, session) => {
  const privateKey = await requireRequestPrivateKey();
  const draft = await parseSavedDraft(privateKey);
  if (!draft) return redirectResponse(COMPOSE_PATH);
  const { recipients, canBulkSend, disabledReason, config } =
    await loadSendContext(draft.target);
  const { sendable, skipped } = await partitionRecipients(
    recipients,
    draft.marketing,
  );
  const { targetLabel, audienceDescription } = await describeTarget(
    draft.target,
    recipients,
  );
  const counts = await getContactCounts(await hashAll(sendable), privateKey);
  return htmlResponse(
    bulkEmailPreviewPage(session, {
      audienceDescription,
      canBulkSend,
      contactSummary: contactFrequencySummary(counts),
      disabledReason,
      draft,
      mailtoLink: buildMailtoLink(
        sendable,
        draft.subject,
        draft.body,
        settings.businessEmail,
      ),
      providerLabel:
        canBulkSend && config ? EMAIL_PROVIDER_LABELS[config.provider] : "",
      recipientCount: recipients.length,
      sendableCount: sendable.length,
      sendableEmails: sendable,
      skippedCount: skipped,
      targetLabel,
    }),
  );
});

/** POST /admin/emails/send — send the saved draft via the bulk provider. */
const handleSendPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, async (_session, _form) => {
    const draft = await parseSavedDraft(await requireRequestPrivateKey());
    if (!draft) {
      return errorRedirect(COMPOSE_PATH, "There's no email to send.");
    }
    const { privateKey, recipients, config } = await loadSendContext(
      draft.target,
    );
    if (!config) {
      return errorRedirect(
        PREVIEW_PATH,
        "Configure your own email provider before sending bulk email.",
      );
    }
    if (recipients.length === 0) {
      return errorRedirect(PREVIEW_PATH, "There are no recipients to send to.");
    }
    const unsubscribed = draft.marketing
      ? await getUnsubscribedHashSet()
      : new Set<string>();
    const payload = await buildBulkPayload({
      bodyHtml: renderMarkdown(draft.body),
      bodyText: draft.body,
      marketing: draft.marketing,
      recipients,
      subject: draft.subject,
      unsubscribed,
    });
    if (payload.recipients.length === 0) {
      return errorRedirect(
        PREVIEW_PATH,
        "Everyone in this audience has unsubscribed.",
      );
    }
    const result = await sendBulkEmails(config, payload);
    await recordContacts(
      await hashAll(payload.recipients.map((r) => r.to)),
      draft.subject,
      privateKey,
    );
    await settings.update.bulkEmailDraft("");
    const providerSummary = summarizeProviderResponse(result.responses);
    const recipientLabel = `${result.attempted} recipient${
      result.attempted === 1 ? "" : "s"
    }`;
    await logActivity(
      `Sent bulk email "${draft.subject}" to ${recipientLabel}. ${providerSummary}`,
      targetLogListingId(draft.target),
    );
    return ok(
      COMPOSE_PATH,
      `Sent to ${recipientLabel} via ${
        EMAIL_PROVIDER_LABELS[config.provider]
      }. ${providerSummary}`,
    );
  });

/** POST /admin/emails/templates — save or update a template. */
/* jscpd:ignore-start */
const handleTemplateSavePost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const result = await validateFormBody(form);
    if (result instanceof Response) return result;
    const { subject, body, target } = result;
    const encSubject = await encryptWithOwnerKey(subject, settings.publicKey);
    const encBody = await encryptWithOwnerKey(body, settings.publicKey);
    const updateExisting = form.get("update_existing") === "1";
    const templateIdParam = form.get("template_id");
    const templateId = templateIdParam
      ? parsePositiveIntId(templateIdParam)
      : null;

    if (updateExisting && templateId !== null) {
      const existing = await getRawEmailTemplate(templateId);
      if (!existing) {
        return errorRedirect(
          `${COMPOSE_PATH}${targetQuery(target)}`,
          "That template no longer exists.",
        );
      }
      await updateEmailTemplate(templateId, encSubject, encBody);
      return ok(
        `${COMPOSE_PATH}${targetQuery(target)}&template=${templateId}`,
        "Template updated.",
      );
    }

    const count = await countEmailTemplates();
    if (count >= MAX_EMAIL_TEMPLATES) {
      return errorRedirect(
        `${COMPOSE_PATH}${targetQuery(target)}`,
        `You've reached the limit of ${MAX_EMAIL_TEMPLATES} saved templates.`,
      );
    }
    const newId = await insertEmailTemplate(encSubject, encBody);
    return ok(
      `${COMPOSE_PATH}${targetQuery(target)}&template=${newId}`,
      "Template saved.",
    );
  });
/* jscpd:ignore-end */

/**
 * GET/POST /admin/emails/templates/:id/delete — typed-confirmation delete,
 * matching the round-trip flow used for other named resources. The subject is
 * encrypted, so it's decrypted with the owner's private key both to display the
 * confirmation page and to be the identifier the owner must re-type.
 */
const templateDelete = createConfirmedHandlers<{ id: number; subject: string }>(
  {
    auth: "owner",
    identifier: (template) => template.subject,
    identifierLabel: "Template subject",
    load: async (id) => {
      const raw = await getRawEmailTemplate(id);
      if (!raw) return null;
      const privateKey = await requireRequestPrivateKey();
      return {
        id,
        subject: await decryptWithOwnerKey(raw.subject, privateKey),
      };
    },
    onConfirm: async (_template, id) => {
      await deleteEmailTemplate(id);
    },
    path: "/admin/emails/templates/:id/delete",
    render: (template, session, error) =>
      bulkEmailTemplateDeletePage(session, template, error),
    successMessage: "Template deleted.",
    successRedirect: `${COMPOSE_PATH}?audience=active`,
  },
);

export const bulkEmailRoutes = defineRoutes({
  ...templateDelete.routes,
  "GET /admin/emails": handleComposeGet,
  "GET /admin/emails/preview": handlePreviewGet,
  "POST /admin/emails/preview": handlePreviewPost,
  "POST /admin/emails/send": handleSendPost,
  "POST /admin/emails/templates": handleTemplateSavePost,
});
