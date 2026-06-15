/**
 * Shared delivery for "someone sends us a message" forms.
 *
 * Both the public contact form and the admin support form take an email + a
 * message, deliver it to a mailbox via the configured email provider, and set
 * the submitter as Reply-To — unless the submitter claims an address on a host
 * we trust (the recipient's host or the site's own sending host), in which case
 * the Reply-To falls back to the from address and a warning is prepended to the
 * body. This module centralises that flow so the two forms stay identical; each
 * caller supplies only its recipient, body wording, and spoof warnings.
 */

import { getEffectiveDomain } from "#shared/config.ts";
import type { FormParams } from "#shared/form-data.ts";
import { escapeHtml } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  emailHost,
  isValidEmail,
  parseEmail,
} from "#shared/validation/email.ts";

/** Flash shown to the submitter when a message could not be delivered. */
export const MESSAGE_SEND_FAILED =
  "Sorry, your message could not be sent. Please try again later.";

/** Subject + plain-text + HTML bodies for one outbound notification. */
export type MessageBody = { subject: string; text: string; html: string };

/** Context passed to a caller's body builder. */
export type MessageBodyContext = {
  /** Submitter's address as typed (already validated by the caller's flow). */
  email: string;
  /** Submitter's message. */
  message: string;
  /** The site's effective domain, for intro/subject lines. */
  domain: string;
  /** Prepended in bold when set: the submitter used a trusted host. */
  warning: string | null;
};

/** Everything a single inbound-message send needs. */
export type InboundMessageSpec = {
  /** Mailbox the message is delivered to (validated; invalid → not sent). */
  recipient: string;
  /** Submitter's address — becomes Reply-To unless it spoofs a trusted host. */
  email: string;
  /** Submitter's message. */
  message: string;
  /** Build the subject and bodies for this form. */
  buildBody: (ctx: MessageBodyContext) => MessageBody;
  /** Warning when the submitter's host matches the recipient's host. */
  spoofsRecipientWarning: string;
  /** Warning when the submitter's host matches the site's sending host. */
  spoofsFromWarning: string;
};

/**
 * Validate a submitted message form (shared by the contact and support forms).
 * Returns an error message, or null when the fields are valid.
 */
export const validateMessageSubmission = (
  email: string,
  message: string,
): string | null => {
  if (!isValidEmail(email)) return "Please enter a valid email address.";
  if (!message) return "Please enter a message.";
  if (message.length > MAX_TEXTAREA_LENGTH) {
    return `Message must be ${MAX_TEXTAREA_LENGTH} characters or fewer.`;
  }
  return null;
};

/** A validated message submission, or the validation error to flash back. */
export type MessageSubmission =
  | { ok: true; email: string; message: string }
  | { ok: false; error: string };

/**
 * Read the email + message fields from a submitted form and validate them.
 * Shared by the contact and support form handlers.
 */
export const readMessageSubmission = (form: FormParams): MessageSubmission => {
  const email = form.getString("email");
  const message = form.getString("message");
  const error = validateMessageSubmission(email, message);
  return error ? { error, ok: false } : { email, message, ok: true };
};

/** HTML body: optional bold warning, the intro line, then from + message. */
export const buildMessageHtml = (
  ctx: MessageBodyContext,
  intro: string,
): string => {
  const warningHtml = ctx.warning
    ? `<p><strong>${escapeHtml(ctx.warning)}</strong></p>`
    : "";
  return (
    warningHtml +
    `<p>${escapeHtml(intro)}</p>` +
    `<p><strong>From:</strong> ${escapeHtml(ctx.email)}</p>` +
    `<p><strong>Message:</strong></p><p>${escapeHtml(ctx.message).replace(/\n/g, "<br>")}</p>`
  );
};

/** Plain-text body mirroring {@link buildMessageHtml}. */
export const buildMessageText = (
  ctx: MessageBodyContext,
  intro: string,
): string => {
  const warningText = ctx.warning ? `${ctx.warning}\n\n` : "";
  return `${warningText}${intro}\n\nFrom: ${ctx.email}\n\nMessage:\n${ctx.message}`;
};

/**
 * Resolve the email provider, validate addresses, apply the anti-spoof
 * Reply-To rule, and send. Returns true when the provider accepts the message
 * (2xx). Uses the DB email config, falling back to the host env config.
 */
export const deliverInboundMessage = async (
  spec: InboundMessageSpec,
): Promise<boolean> => {
  const { getEmailConfig, getHostEmailConfig, sendEmail } = await import(
    "#shared/email.ts"
  );
  const config = getEmailConfig() ?? getHostEmailConfig();
  if (!config) {
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: "inbound message: no email provider configured",
    });
    return false;
  }

  const recipient = parseEmail(spec.recipient);
  if (!recipient) return false;
  const senderEmail = parseEmail(spec.email);
  if (!senderEmail) return false;
  const fromAddress = config.fromAddress;

  // Anti-spoof: when the submitter claims an address on a host we trust (the
  // recipient's host, or the site's own sending host), a Reply-To of that
  // address makes the message look self-sent and receiving mailboxes munge the
  // visible sender. Fall back to the from address and flag it in the body.
  const senderHost = emailHost(senderEmail);
  const warning =
    senderHost === emailHost(recipient)
      ? spec.spoofsRecipientWarning
      : senderHost === emailHost(fromAddress)
        ? spec.spoofsFromWarning
        : null;
  const { subject, text, html } = spec.buildBody({
    domain: getEffectiveDomain(),
    email: spec.email,
    message: spec.message,
    warning,
  });
  const status = await sendEmail(config, {
    html,
    replyTo: warning !== null ? fromAddress : senderEmail,
    subject,
    text,
    to: recipient,
  });
  return status !== undefined && status < 300;
};
