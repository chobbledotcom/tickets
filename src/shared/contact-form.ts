/**
 * Public contact form: availability rules and message delivery.
 *
 * The feature is gated three ways:
 *  - the host configures Botpoison (both env keys) — see isBotpoisonEnabled
 *  - the owner enables the form on the admin contact page
 *  - the site has a business email address to deliver messages to
 *
 * Only when all three hold is the public form shown and submissions accepted.
 */

import {
  getBotpoisonPublicKey,
  getEffectiveDomain,
  isBotpoisonEnabled,
} from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { escapeHtml } from "#shared/jsx/jsx-runtime.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

/**
 * Whether the contact form feature is available to configure.
 * True when the host has set both Botpoison env keys.
 */
export const isContactFormAvailable = (): boolean => isBotpoisonEnabled();

/**
 * Whether the public contact form should be rendered and accept submissions:
 * Botpoison configured + owner enabled it + a business email is set.
 */
export const isContactFormActive = (): boolean =>
  isBotpoisonEnabled() &&
  settings.contactFormEnabled &&
  settings.businessEmail !== "";

/** Public Botpoison key to embed in the form for the browser widget. */
export const contactFormPublicKey = (): string => getBotpoisonPublicKey();

/** Build the owner-notification email body (plain text + escaped HTML). */
const buildMessageBody = (
  email: string,
  message: string,
): { subject: string; text: string; html: string } => {
  const domain = getEffectiveDomain();
  return {
    html:
      `<p>You have received a message via the ${escapeHtml(domain)} contact form.</p>` +
      `<p><strong>From:</strong> ${escapeHtml(email)}</p>` +
      `<p><strong>Message:</strong></p><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
    subject: `Contact form message from ${email}`,
    text: `You have received a message via the ${domain} contact form.\n\nFrom: ${email}\n\nMessage:\n${message}`,
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

  const { subject, text, html } = buildMessageBody(email, message);
  const status = await sendEmail(config, {
    html,
    replyTo: email,
    subject,
    text,
    to: businessEmail,
  });
  return status !== undefined && status < 300;
};
