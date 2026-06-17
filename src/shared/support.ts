/**
 * Admin "Support" feature.
 *
 * When ADMIN_EMAIL_ADDRESS is configured (the same env var that powers the
 * superuser recovery system) the admin area gains a Support page: the platform
 * host's SUPPORT_PAGE_TEXT (markdown) plus a message form that delivers to the
 * host. The site operator is the only sender, so there's no submitter email to
 * collect — the message is sent from the host's own address, with the site's
 * business email as both the Reply-To and the "From:" shown to the host. For a
 * short, configurable window after a submission the page nags about repeat
 * sends to discourage duplicates.
 */

import { getEffectiveDomain } from "#shared/config.ts";
import { formatTimeAgo } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import {
  deliverMessage,
  resolveMessageEmailConfig,
} from "#shared/inbound-message.ts";
import { SUPPORT_FORM_NAG_DAYS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { getAdminEmailAddress } from "#shared/superuser.ts";
import { parseEmail } from "#shared/validation/email.ts";

/**
 * The SUPPORT_PAGE_TEXT markdown the host configured, with literal `\n`
 * sequences turned into real line breaks (env values can't easily hold real
 * newlines). Null when unset or blank.
 */
export const getSupportPageText = (): string | null => {
  const raw = getEnv("SUPPORT_PAGE_TEXT");
  if (!raw?.trim()) return null;
  return raw.replace(/\\n/g, "\n");
};

/** The Support feature is available when ADMIN_EMAIL_ADDRESS is set and valid. */
export const isSupportEnabled = (): boolean => getAdminEmailAddress() !== null;

/**
 * Whether the support form can be shown and accept submissions: the feature is
 * enabled and a business email is set. The business email is the address the
 * host replies to, and (like the contact form) the from address falls back to
 * it when no dedicated sending address is configured.
 */
export const isSupportFormActive = (): boolean =>
  isSupportEnabled() && settings.businessEmail !== "";

/** Subject line for support messages — identifies the originating site. */
export const supportSubject = (domain: string): string =>
  `Support message from Chobble Tickets site ${domain}`;

/**
 * Deliver a support message to ADMIN_EMAIL_ADDRESS. The site operator is the
 * sender, so we use the site's business email as Reply-To and the displayed
 * "From:", while the envelope sender stays the host's configured address.
 * Returns false when the feature isn't fully configured or delivery fails.
 */
export const sendSupportMessage = async (message: string): Promise<boolean> => {
  const to = getAdminEmailAddress();
  const businessEmail = parseEmail(settings.businessEmail);
  if (!to || !businessEmail) return false;
  const config = await resolveMessageEmailConfig();
  if (!config) return false;
  const domain = getEffectiveDomain();
  return deliverMessage(config, {
    body: { fromLabel: businessEmail, message },
    intro: `You have received a support message from the Chobble Tickets site ${domain}.`,
    replyTo: businessEmail,
    subject: supportSubject(domain),
    to,
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
