/**
 * Public contact form: availability rules and message delivery.
 *
 * The form itself only needs two things:
 *  - the owner enables it on the admin contact page
 *  - the site has a business email address to deliver messages to
 *
 * Spam protection is a progressive enhancement layered on top: when Botpoison
 * is configured (both env keys) the form gains a proof-of-work widget and
 * submissions are verified server-side. Without it the form still works, ready
 * for a different spam-protection provider to be added in future.
 */

import { parseEmail, type ValidEmail } from "#shared/business-email.ts";
import { getBotpoisonPublicKey, getEffectiveDomain } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { escapeHtml } from "#shared/jsx/jsx-runtime.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

/**
 * Whether the public contact form should be rendered and accept submissions:
 * the owner enabled it and a business email is set. Botpoison is not required.
 */
export const isContactFormActive = (): boolean =>
  settings.contactFormEnabled && settings.businessEmail !== "";

/** Public Botpoison key to embed in the form for the browser widget. Empty when
 * Botpoison is not configured, in which case no widget is shown. */
export const contactFormPublicKey = (): string => getBotpoisonPublicKey();

/** Host (everything after the last `@`) of a validated email address. The
 * ValidEmail type guarantees a normalized address with a host, so there is no
 * empty-host case to handle — and the compiler forbids passing a raw string. */
const emailHost = (email: ValidEmail): string =>
  email.slice(email.lastIndexOf("@") + 1);

/** Bold warning prepended when the submitter claimed an address on the owner's
 * own business email host. */
const SPOOF_BUSINESS_WARNING =
  "It looks like this sender entered an email address on your own business email host. They may be attempting to spoof you.";

/** Bold warning prepended when the submitter claimed an address on the site's
 * sending (from) email host. */
const SPOOF_FROM_WARNING =
  "It looks like this sender entered an email address on this site's sending email host. They may be attempting to spoof the host.";

/**
 * Build the owner-notification email body (plain text + escaped HTML).
 * When `warning` is set, it is prepended in bold: the submitter used a trusted
 * email host, which we no longer trust as a Reply-To target.
 */
const buildMessageBody = (
  email: string,
  message: string,
  warning: string | null,
): { subject: string; text: string; html: string } => {
  const domain = getEffectiveDomain();
  const warningHtml = warning
    ? `<p><strong>${escapeHtml(warning)}</strong></p>`
    : "";
  const warningText = warning ? `${warning}\n\n` : "";
  return {
    html:
      warningHtml +
      `<p>You have received a message via the ${escapeHtml(domain)} contact form.</p>` +
      `<p><strong>From:</strong> ${escapeHtml(email)}</p>` +
      `<p><strong>Message:</strong></p><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
    subject: `Contact form message from ${email}`,
    text: `${warningText}You have received a message via the ${domain} contact form.\n\nFrom: ${email}\n\nMessage:\n${message}`,
  };
};

/**
 * Send a contact-form message to the site's business email.
 * Uses the configured email provider (DB settings, falling back to host env).
 * The submitter's address is set as Reply-To so the owner can reply directly.
 * Returns true when the provider accepted the message.
 */
export const sendContactMessage = async (
  email: string,
  message: string,
): Promise<boolean> => {
  const { getEmailConfig, getHostEmailConfig, sendEmail } = await import(
    "#shared/email.ts"
  );
  const config = getEmailConfig() ?? getHostEmailConfig();
  if (!config) {
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: "contact form: no email provider configured",
    });
    return false;
  }

  // Parse every address through the same validator before any host comparison.
  // The branded ValidEmail values let emailHost rely on a host being present;
  // anything malformed (including the env-sourced from address) is rejected
  // here rather than silently mishandled downstream.
  const businessEmail = parseEmail(settings.businessEmail);
  if (!businessEmail) return false;
  const fromAddress = parseEmail(config.fromAddress);
  if (!fromAddress) return false;
  const senderEmail = parseEmail(email);
  if (!senderEmail) return false;

  // Anti-spoof: when the submitter claims an address on a host we trust (the
  // owner's business email host, or the site's own sending host), a Reply-To
  // of that address makes the message look self-sent and receiving mailboxes
  // munge the visible sender (e.g. noreply@invalid.invalid). Fall back to the
  // normal from address and flag it in the body instead.
  const senderHost = emailHost(senderEmail);
  const spoofsBusiness = senderHost === emailHost(businessEmail);
  const spoofsFrom = senderHost === emailHost(fromAddress);
  const warning = spoofsBusiness
    ? SPOOF_BUSINESS_WARNING
    : spoofsFrom
      ? SPOOF_FROM_WARNING
      : null;
  const spoofed = warning !== null;
  const { subject, text, html } = buildMessageBody(email, message, warning);
  const status = await sendEmail(config, {
    html,
    replyTo: spoofed ? fromAddress : senderEmail,
    subject,
    text,
    to: businessEmail,
  });
  return status !== undefined && status < 300;
};
