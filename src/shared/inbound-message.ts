/**
 * Shared building blocks for the "send us a message" email forms.
 *
 * The public contact form and the admin support form both turn a short message
 * into an email sent via the configured provider, but their delivery policy
 * differs (who the recipient is, what Reply-To to use, whether anti-spoofing
 * applies). That policy lives in each form's module; this file only provides
 * the pieces they share: message-field validation, the notification body
 * builders, provider resolution, and the low-level send.
 *
 * Addresses are passed in already validated (as `ValidEmail`): callers resolve
 * them from trusted sources (env, settings) or the form's own validation, so
 * the send path never re-validates an address.
 */

import type { EmailConfig } from "#shared/email.ts";
import { escapeHtml } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ValidEmail } from "#shared/validation/email.ts";

/** Flash shown to the submitter when a message could not be delivered. */
export const MESSAGE_SEND_FAILED =
  "Sorry, your message could not be sent. Please try again later.";

/** Validate the free-text message of a message form. Returns an error message,
 * or null when it's present and within the length limit. */
export const validateMessageText = (message: string): string | null => {
  if (!message) return "Please enter a message.";
  if (message.length > MAX_TEXTAREA_LENGTH) {
    return `Message must be ${MAX_TEXTAREA_LENGTH} characters or fewer.`;
  }
  return null;
};

/** Body content for a notification email: who it's from (shown to the reader),
 * the message itself, and an optional bold warning prepended to both bodies. */
export type MessageBody = {
  /** Address shown in the "From:" line of the body (not the envelope sender). */
  fromLabel: string;
  message: string;
  warning?: string | null;
};

/** HTML body: optional bold warning, the intro line, then from + message. */
export const buildMessageHtml = (body: MessageBody, intro: string): string => {
  const warningHtml = body.warning
    ? `<p><strong>${escapeHtml(body.warning)}</strong></p>`
    : "";
  return (
    warningHtml +
    `<p>${escapeHtml(intro)}</p>` +
    `<p><strong>From:</strong> ${escapeHtml(body.fromLabel)}</p>` +
    `<p><strong>Message:</strong></p><p>${escapeHtml(body.message).replace(/\n/g, "<br>")}</p>`
  );
};

/** Plain-text body mirroring {@link buildMessageHtml}. */
export const buildMessageText = (body: MessageBody, intro: string): string => {
  const warningText = body.warning ? `${body.warning}\n\n` : "";
  return `${warningText}${intro}\n\nFrom: ${body.fromLabel}\n\nMessage:\n${body.message}`;
};

/** Resolve the email provider config (DB settings, then host env), logging when
 * neither is configured. Returned config carries the envelope `fromAddress`. */
export const resolveMessageEmailConfig =
  async (): Promise<EmailConfig | null> => {
    const { getEmailConfig, getHostEmailConfig } = await import(
      "#shared/email.ts"
    );
    const config = getEmailConfig() ?? getHostEmailConfig();
    if (!config) {
      logError({
        code: ErrorCode.EMAIL_SEND,
        detail: "message form: no email provider configured",
      });
    }
    return config;
  };

/**
 * Send a built notification via the resolved provider. The envelope sender is
 * the provider's from address; `to` and `replyTo` are already-valid addresses
 * supplied by the caller. Returns true when the provider accepts it (2xx).
 */
export const deliverMessage = async (
  config: EmailConfig,
  opts: {
    to: ValidEmail;
    replyTo?: ValidEmail;
    subject: string;
    intro: string;
    body: MessageBody;
  },
): Promise<boolean> => {
  const { sendEmail } = await import("#shared/email.ts");
  const status = await sendEmail(config, {
    html: buildMessageHtml(opts.body, opts.intro),
    ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
    subject: opts.subject,
    text: buildMessageText(opts.body, opts.intro),
    to: opts.to,
  });
  return status !== undefined && status < 300;
};
