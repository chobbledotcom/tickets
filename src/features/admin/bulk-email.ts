/**
 * Bulk email routes — compose, preview, and send. Owner-only.
 *
 * Flow: compose (GET) → preview (POST saves a draft, redirects) → preview
 * (GET renders the saved draft) → send (POST). The draft is persisted in
 * settings so the preview redirect can carry a Markdown body too large for a
 * flash cookie, and so the send step re-reads exactly what was previewed.
 */

import { requirePrivateKey } from "#routes/admin/actions.ts";
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
  audienceById,
  type BulkEmailTarget,
  buildBulkMessages,
  buildMailtoLink,
  DEFAULT_AUDIENCE_ID,
  isAudienceId,
  parseDraft,
  resolveRecipientEmails,
  serializeDraft,
  targetQuery,
  validateDraftInput,
} from "#shared/bulk-email.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getEventWithCount } from "#shared/db/events.ts";
import { settings } from "#shared/db/settings.ts";
import { getUnsubscribedHashSet, hashEmail } from "#shared/db/unsubscribes.ts";
import {
  EMAIL_PROVIDER_LABELS,
  type EmailConfig,
  getEmailConfig,
  isBulkEmailProvider,
  sendBulkEmails,
} from "#shared/email.ts";
import type { FormParams } from "#shared/form-data.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { ok } from "#shared/response.ts";
import {
  bulkEmailComposePage,
  bulkEmailPreviewPage,
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
  if (!config) {
    return {
      canBulkSend: false,
      config: null,
      disabledReason:
        "You haven't configured your own email provider, so the system won't send bulk email for you — sending marketing from a shared address risks the whole platform's deliverability. Add your provider under Settings → Advanced → Email Notifications.",
    };
  }
  if (!isBulkEmailProvider(config.provider)) {
    return {
      canBulkSend: false,
      config,
      disabledReason: `Your email provider (${
        EMAIL_PROVIDER_LABELS[config.provider]
      }) doesn't support batch sending, which bulk email needs. Switch to Resend or Postmark to send through the system.`,
    };
  }
  return { canBulkSend: true, config, disabledReason: "" };
};

/** Resolve an event id string to a target + name, or null if absent/invalid/gone. */
const eventTargetFromId = async (
  raw: string,
): Promise<{ target: BulkEmailTarget; eventName: string } | null> => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const event = await getEventWithCount(id);
  if (!event) return null;
  return { eventName: event.name, target: { eventId: id, kind: "event" } };
};

/** Build an audience target from a raw value, defaulting unknown/blank input. */
const audienceTargetFrom = (raw: string | null): BulkEmailTarget => ({
  audience: raw && isAudienceId(raw) ? raw : DEFAULT_AUDIENCE_ID,
  kind: "audience",
});

/** Resolve a compose-page target from query params, or null if the event is gone. */
const resolveComposeTarget = (
  request: Request,
): Promise<{ target: BulkEmailTarget; eventName?: string } | null> => {
  const params = new URL(request.url).searchParams;
  const eventParam = params.get("event");
  if (eventParam !== null) return eventTargetFromId(eventParam);
  return Promise.resolve({
    target: audienceTargetFrom(params.get("audience")),
  });
};

/** Resolve a target from posted form fields, or null if a named event is gone. */
const parseFormTarget = async (
  form: FormParams,
): Promise<BulkEmailTarget | null> => {
  const eventIdStr = form.getString("event_id");
  if (eventIdStr) {
    const resolved = await eventTargetFromId(eventIdStr);
    return resolved ? resolved.target : null;
  }
  return audienceTargetFrom(form.getString("audience"));
};

/** Resolve recipient emails for a target using the owner's private key. */
const recipientsFor = async (
  session: AuthSession,
  target: BulkEmailTarget,
): Promise<string[]> =>
  resolveRecipientEmails(target, await requirePrivateKey(session));

/** Recipients for a target plus the owner's bulk-send availability. */
const loadSendContext = async (
  session: AuthSession,
  target: BulkEmailTarget,
): Promise<{ recipients: string[] } & BulkAvailability> => ({
  recipients: await recipientsFor(session, target),
  ...getBulkAvailability(),
});

/** Wrap an owner-only page builder: gate on owner, apply flash, then build. */
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

/** Human label + optional description for a target. */
const describeTarget = async (
  target: BulkEmailTarget,
): Promise<{ targetLabel: string; audienceDescription?: string }> => {
  if (target.kind === "event") {
    const event = await getEventWithCount(target.eventId);
    return {
      targetLabel: event ? `Attendees of ${event.name}` : "Event attendees",
    };
  }
  const audience = audienceById(target.audience);
  return {
    audienceDescription: audience.description,
    targetLabel: audience.label,
  };
};

/** GET /admin/emails — compose form. */
const handleComposeGet = ownerEmailPage(async (request, session) => {
  const resolved = await resolveComposeTarget(request);
  if (!resolved) return notFoundResponse();
  const { recipients, canBulkSend, disabledReason } = await loadSendContext(
    session,
    resolved.target,
  );
  return htmlResponse(
    bulkEmailComposePage(session, {
      canBulkSend,
      disabledReason,
      draft: parseDraft(settings.bulkEmailDraft),
      eventName: resolved.eventName,
      recipientCount: recipients.length,
      target: resolved.target,
    }),
  );
});

/** POST /admin/emails/preview — validate, persist the draft, redirect to preview. */
const handlePreviewPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const target = await parseFormTarget(form);
    if (!target) {
      return errorRedirect(COMPOSE_PATH, "That event no longer exists.");
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
    await settings.update.bulkEmailDraft(serializeDraft(validation.draft));
    return ok(PREVIEW_PATH, "Review your email below before sending.");
  });

/** GET /admin/emails/preview — render the saved draft for confirmation. */
const handlePreviewGet = ownerEmailPage(async (_request, session) => {
  const draft = parseDraft(settings.bulkEmailDraft);
  if (!draft) return redirectResponse(COMPOSE_PATH);
  const { recipients, canBulkSend, disabledReason, config } =
    await loadSendContext(session, draft.target);
  const { sendable, skipped } = await partitionRecipients(
    recipients,
    draft.marketing,
  );
  const { targetLabel, audienceDescription } = await describeTarget(
    draft.target,
  );
  return htmlResponse(
    bulkEmailPreviewPage(session, {
      audienceDescription,
      canBulkSend,
      disabledReason,
      draft,
      mailtoLink: buildMailtoLink(sendable, draft.subject, draft.body),
      providerLabel:
        canBulkSend && config ? EMAIL_PROVIDER_LABELS[config.provider] : "",
      recipientCount: recipients.length,
      sendableCount: sendable.length,
      skippedCount: skipped,
      targetLabel,
    }),
  );
});

/** POST /admin/emails/send — send the saved draft via the bulk provider. */
const handleSendPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, async (session, _form) => {
    const draft = parseDraft(settings.bulkEmailDraft);
    if (!draft) {
      return errorRedirect(COMPOSE_PATH, "There's no email to send.");
    }
    const config = getEmailConfig();
    if (!config || !isBulkEmailProvider(config.provider)) {
      return errorRedirect(
        PREVIEW_PATH,
        "Bulk sending needs your own batch-capable email provider (Resend or Postmark).",
      );
    }
    const recipients = await recipientsFor(session, draft.target);
    if (recipients.length === 0) {
      return errorRedirect(PREVIEW_PATH, "There are no recipients to send to.");
    }
    const unsubscribed = draft.marketing
      ? await getUnsubscribedHashSet()
      : new Set<string>();
    const messages = await buildBulkMessages({
      bodyHtml: renderMarkdown(draft.body),
      bodyText: draft.body,
      marketing: draft.marketing,
      recipients,
      unsubscribed,
    });
    if (messages.length === 0) {
      return errorRedirect(
        PREVIEW_PATH,
        "Everyone in this audience has unsubscribed.",
      );
    }
    const result = await sendBulkEmails(
      config,
      config.provider,
      draft.subject,
      messages,
    );
    await settings.update.bulkEmailDraft("");
    await logActivity(
      `Sent bulk email "${draft.subject}" to ${result.attempted} recipient(s)`,
    );
    return ok(
      COMPOSE_PATH,
      `Sent to ${result.attempted} recipient${
        result.attempted === 1 ? "" : "s"
      }.`,
    );
  });

export const bulkEmailRoutes = defineRoutes({
  "GET /admin/emails": handleComposeGet,
  "GET /admin/emails/preview": handlePreviewGet,
  "POST /admin/emails/preview": handlePreviewPost,
  "POST /admin/emails/send": handleSendPost,
});
