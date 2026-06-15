/**
 * Admin "Support" feature.
 *
 * When ADMIN_EMAIL_ADDRESS is configured (the same env var that powers the
 * superuser recovery system) the admin area gains a Support page: the platform
 * host's SUPPORT_PAGE_TEXT (markdown) plus a message form that delivers to the
 * host. The form reuses the contact-form delivery pipeline but targets the
 * admin address and needs no Botpoison. For a short, configurable window after
 * a submission the page nags about repeat sends to discourage duplicates.
 */

import { formatTimeAgo } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import {
  buildMessageHtml,
  buildMessageText,
  deliverInboundMessage,
} from "#shared/inbound-message.ts";
import { SUPPORT_FORM_NAG_DAYS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { getAdminEmailAddress } from "#shared/superuser.ts";

/**
 * The SUPPORT_PAGE_TEXT markdown the host configured, with literal `\n`
 * sequences turned into real line breaks (env values can't easily hold real
 * newlines). Null when unset or blank.
 */
export const getSupportPageText = (): string | null => {
  const raw = getEnv("SUPPORT_PAGE_TEXT");
  if (!raw || !raw.trim()) return null;
  return raw.replace(/\\n/g, "\n");
};

/** The Support feature is available when ADMIN_EMAIL_ADDRESS is set and valid. */
export const isSupportEnabled = (): boolean => getAdminEmailAddress() !== null;

/**
 * Whether the support form can be shown and accept submissions: the feature is
 * enabled and a business email is set. Mirrors the public contact form's
 * delivery requirement (the from address falls back to the business email).
 */
export const isSupportFormActive = (): boolean =>
  isSupportEnabled() && settings.businessEmail !== "";

/** Warning when the submitter claimed an address on the support inbox's host. */
const SPOOF_RECIPIENT_WARNING =
  "It looks like this sender entered an email address on the support inbox's own host. They may be attempting to spoof it.";

/** Warning when the submitter claimed an address on the site's sending host. */
const SPOOF_FROM_WARNING =
  "It looks like this sender entered an email address on this site's sending email host. They may be attempting to spoof the host.";

/** Intro line for the support-notification body. */
const supportIntro = (domain: string): string =>
  `You have received a support message from the Chobble Tickets site ${domain}.`;

/** Subject line for support messages — identifies the originating site. */
export const supportSubject = (domain: string): string =>
  `Support message from Chobble Tickets site ${domain}`;

/**
 * Deliver a support message to ADMIN_EMAIL_ADDRESS. Returns false when the
 * feature is disabled or delivery fails.
 */
export const sendSupportMessage = (
  email: string,
  message: string,
): Promise<boolean> => {
  const adminEmail = getAdminEmailAddress();
  if (!adminEmail) return Promise.resolve(false);
  return deliverInboundMessage({
    buildBody: (ctx) => ({
      html: buildMessageHtml(ctx, supportIntro(ctx.domain)),
      subject: supportSubject(ctx.domain),
      text: buildMessageText(ctx, supportIntro(ctx.domain)),
    }),
    email,
    message,
    recipient: adminEmail,
    spoofsFromWarning: SPOOF_FROM_WARNING,
    spoofsRecipientWarning: SPOOF_RECIPIENT_WARNING,
  });
};

/** Record that the support form was just submitted (stores an ISO timestamp). */
export const recordSupportSubmission = (): Promise<void> =>
  settings.update.supportFormLastSubmitted();

/**
 * Pure: the "time ago" label to nag with when `last` is a timestamp within
 * `days` of `now`, otherwise null. Never nags for a missing, future, or
 * expired (older than the window) submission.
 */
export const supportNagFor = (
  last: string | null,
  nowMsValue: number,
  days: number,
): string | null => {
  if (!last) return null;
  const ago = formatTimeAgo(last, nowMsValue);
  if (!ago) return null;
  const windowMs = days * 86_400_000;
  return nowMsValue - Date.parse(last) <= windowMs ? ago : null;
};

/** Current support-form nag label, or null when there's nothing to nag about. */
export const supportNagLabel = (): string | null =>
  supportNagFor(
    settings.supportFormLastSubmitted || null,
    nowMs(),
    SUPPORT_FORM_NAG_DAYS,
  );
