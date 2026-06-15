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
  buildBulkPayload,
  buildMailtoLink,
  contactFrequencySummary,
  DEFAULT_AUDIENCE_ID,
  isAudienceId,
  parseDraft,
  resolveRecipientEmails,
  serializeDraft,
  summarizeProviderResponse,
  targetQuery,
  validateDraftInput,
} from "#shared/bulk-email.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  getContactCounts,
  getUnsubscribedHashSet,
  hashEmail,
  recordContacts,
} from "#shared/db/email-preferences.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import {
  EMAIL_PROVIDER_LABELS,
  type EmailConfig,
  getEmailConfig,
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
  return config
    ? { canBulkSend: true, config, disabledReason: "" }
    : {
        canBulkSend: false,
        config: null,
        disabledReason:
          "You haven't configured your own email provider, so the system won't send bulk email for you. Sending marketing from a shared address risks the whole platform's deliverability.",
      };
};

/** Resolve a listing id string to a target + name, or null if absent/invalid/gone. */
const listingTargetFromId = async (
  raw: string,
): Promise<{ target: BulkEmailTarget; listingName: string } | null> => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const listing = await getListingWithCount(id);
  if (!listing) return null;
  return {
    listingName: listing.name,
    target: { kind: "listing", listingId: id },
  };
};

/** Build an audience target from a raw value, defaulting unknown/blank input. */
const audienceTargetFrom = (raw: string | null): BulkEmailTarget => ({
  audience: raw && isAudienceId(raw) ? raw : DEFAULT_AUDIENCE_ID,
  kind: "audience",
});

/** Resolve a compose-page target from query params, or null if the listing is gone. */
const resolveComposeTarget = (
  request: Request,
): Promise<{ target: BulkEmailTarget; listingName?: string } | null> => {
  const params = new URL(request.url).searchParams;
  const attendeeParam = params.get("attendee");
  if (attendeeParam !== null) {
    return Promise.resolve({
      target: { kind: "attendee", token: attendeeParam },
    });
  }
  const listingParam = params.get("listing");
  if (listingParam !== null) return listingTargetFromId(listingParam);
  return Promise.resolve({
    target: audienceTargetFrom(params.get("audience")),
  });
};

/** Resolve a target from posted form fields, or null if a named listing is gone. */
const parseFormTarget = async (
  form: FormParams,
): Promise<BulkEmailTarget | null> => {
  const attendeeToken = form.getString("attendee");
  if (attendeeToken) return { kind: "attendee", token: attendeeToken };
  const listingIdStr = form.getString("listing_id");
  if (listingIdStr) {
    const resolved = await listingTargetFromId(listingIdStr);
    return resolved ? resolved.target : null;
  }
  return audienceTargetFrom(form.getString("audience"));
};

/** Recipients + the private key used + the owner's bulk-send availability. */
const loadSendContext = async (
  session: AuthSession,
  target: BulkEmailTarget,
): Promise<
  { privateKey: CryptoKey; recipients: string[] } & BulkAvailability
> => {
  const privateKey = await requirePrivateKey(session);
  return {
    privateKey,
    recipients: await resolveRecipientEmails(target, privateKey),
    ...getBulkAvailability(),
  };
};

/** Hash a list of recipient emails (parallel). */
const hashAll = (emails: string[]): Promise<string[]> =>
  Promise.all(emails.map((e) => hashEmail(e)));

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

/** Human label + optional description for a target. The resolved recipient
 * list labels a single-attendee send with that attendee's own address. */
const describeTarget = async (
  target: BulkEmailTarget,
  recipients: string[],
): Promise<{ targetLabel: string; audienceDescription?: string }> => {
  if (target.kind === "listing") {
    const listing = await getListingWithCount(target.listingId);
    return {
      targetLabel: listing
        ? `Attendees of ${listing.name}`
        : "Listing attendees",
    };
  }
  if (target.kind === "attendee") {
    return { targetLabel: recipients[0] ?? "the selected attendee" };
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
  // A listing or attendee target with no emailable recipient (an unknown
  // attendee token, or nobody with an email on file) has nothing to send to —
  // treat it as not found rather than rendering an empty compose page. Named
  // audiences are allowed to be empty (they may fill up later).
  if (resolved.target.kind !== "audience" && recipients.length === 0) {
    return notFoundResponse();
  }
  return htmlResponse(
    bulkEmailComposePage(session, {
      attendeeEmail:
        resolved.target.kind === "attendee" ? recipients[0] : undefined,
      canBulkSend,
      disabledReason,
      draft: parseDraft(settings.bulkEmailDraft),
      listingName: resolved.listingName,
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
    await settings.update.bulkEmailDraft(serializeDraft(validation.draft));
    return ok(PREVIEW_PATH, "Review your email below before sending.");
  });

/** GET /admin/emails/preview — render the saved draft for confirmation. */
const handlePreviewGet = ownerEmailPage(async (_request, session) => {
  const draft = parseDraft(settings.bulkEmailDraft);
  if (!draft) return redirectResponse(COMPOSE_PATH);
  const { recipients, privateKey, canBulkSend, disabledReason, config } =
    await loadSendContext(session, draft.target);
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
      mailtoLink: buildMailtoLink(sendable, draft.subject, draft.body),
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
  withAuth(request, OWNER_FORM, async (session, _form) => {
    const draft = parseDraft(settings.bulkEmailDraft);
    if (!draft) {
      return errorRedirect(COMPOSE_PATH, "There's no email to send.");
    }
    const { privateKey, recipients, config } = await loadSendContext(
      session,
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
      draft.target.kind === "listing" ? draft.target.listingId : null,
    );
    return ok(
      COMPOSE_PATH,
      `Sent to ${recipientLabel} via ${
        EMAIL_PROVIDER_LABELS[config.provider]
      }. ${providerSummary}`,
    );
  });

export const bulkEmailRoutes = defineRoutes({
  "GET /admin/emails": handleComposeGet,
  "GET /admin/emails/preview": handlePreviewGet,
  "POST /admin/emails/preview": handlePreviewPost,
  "POST /admin/emails/send": handleSendPost,
});
