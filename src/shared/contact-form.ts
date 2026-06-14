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

/** Case-insensitive comparison of two email addresses. */
const sameEmail = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Bold warning prepended when the submitter claimed the owner's own address. */
const SPOOF_WARNING =
  "It looks like this sender entered your own business email address — they may be attempting to spoof you.";

/**
 * Build the owner-notification email body (plain text + escaped HTML).
 * When `spoofed` is set, a bold warning is prepended: the submitter used the
 * owner's own business email, which we no longer trust as a Reply-To target.
 */
const buildMessageBody = (
  email: string,
  message: string,
  spoofed: boolean,
): { subject: string; text: string; html: string } => {
  const domain = getEffectiveDomain();
  const warningHtml = spoofed
    ? `<p><strong>${escapeHtml(SPOOF_WARNING)}</strong></p>`
    : "";
  const warningText = spoofed ? `${SPOOF_WARNING}\n\n` : "";
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

  const businessEmail = settings.businessEmail;
  if (!businessEmail) return false;

  // Anti-spoof: when the submitter claims the owner's own address, a
  // Reply-To of that address makes the message look self-sent and receiving
  // mailboxes munge the visible sender (e.g. noreply@invalid.invalid). Fall
  // back to the normal from address and flag it in the body instead.
  const spoofed = sameEmail(email, businessEmail);
  const { subject, text, html } = buildMessageBody(email, message, spoofed);
  const status = await sendEmail(config, {
    html,
    replyTo: spoofed ? config.fromAddress : email,
    subject,
    text,
    to: businessEmail,
  });
  return status !== undefined && status < 300;
};
