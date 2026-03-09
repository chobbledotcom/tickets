/**
 * Email sending module
 * Sends registration emails via HTTP email APIs (Resend, Postmark, SendGrid)
 */

import { getBusinessEmailFromDb } from "#lib/business-email.ts";
import {
  getEmailApiKeyFromDb,
  getEmailFromAddressFromDb,
  getEmailProviderFromDb,
} from "#lib/db/settings.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { buildTicketUrl } from "#lib/ticket-url.ts";
import type { RegistrationEntry } from "#lib/webhook.ts";
import { registrationConfirmation } from "#templates/email/registration-confirmation.ts";
import { adminNotification } from "#templates/email/admin-notification.ts";

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

export type EmailConfig = {
  provider: string;
  apiKey: string;
  fromAddress: string;
};

/** Read email config from DB settings. Falls back to business email for fromAddress. Returns null if not configured. */
export const getEmailConfig = async (): Promise<EmailConfig | null> => {
  const [provider, apiKey, fromAddress, businessEmail] = await Promise.all([
    getEmailProviderFromDb(),
    getEmailApiKeyFromDb(),
    getEmailFromAddressFromDb(),
    getBusinessEmailFromDb(),
  ]);
  const from = fromAddress || businessEmail;
  if (!provider || !apiKey || !from) return null;
  return { provider, apiKey, fromAddress: from };
};

/** POST JSON to a URL with custom headers */
const postJson = (url: string, headers: Record<string, string>, body: unknown): Promise<Response> =>
  fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Build provider-specific request: [url, extra-headers, body] */
type ProviderRequest = (config: EmailConfig, msg: EmailMessage) => [string, Record<string, string>, unknown];

const resendRequest: ProviderRequest = (config, msg) => [
  "https://api.resend.com/emails",
  { "Authorization": `Bearer ${config.apiKey}` },
  { from: config.fromAddress, to: [msg.to], reply_to: msg.replyTo, subject: msg.subject, html: msg.html, text: msg.text },
];

const postmarkRequest: ProviderRequest = (config, msg) => [
  "https://api.postmarkapp.com/email",
  { "X-Postmark-Server-Token": config.apiKey, "Accept": "application/json" },
  { From: config.fromAddress, To: msg.to, ReplyTo: msg.replyTo, Subject: msg.subject, HtmlBody: msg.html, TextBody: msg.text },
];

const sendgridRequest: ProviderRequest = (config, msg) => [
  "https://api.sendgrid.com/v3/mail/send",
  { "Authorization": `Bearer ${config.apiKey}` },
  {
    personalizations: [{ to: [{ email: msg.to }] }],
    from: { email: config.fromAddress },
    reply_to: msg.replyTo ? { email: msg.replyTo } : undefined,
    subject: msg.subject,
    content: [{ type: "text/plain", value: msg.text }, { type: "text/html", value: msg.html }],
  },
];

const PROVIDERS: Record<string, ProviderRequest> = {
  resend: resendRequest,
  postmark: postmarkRequest,
  sendgrid: sendgridRequest,
};

/** Send a single email via the configured provider. Logs errors, never throws. */
export const sendEmail = async (config: EmailConfig, msg: EmailMessage): Promise<void> => {
  const buildRequest = PROVIDERS[config.provider];
  if (!buildRequest) {
    logError({ code: ErrorCode.EMAIL_SEND, detail: `unknown provider: ${config.provider}` });
    return;
  }
  try {
    const [url, headers, body] = buildRequest(config, msg);
    const response = await postJson(url, headers, body);
    if (!response.ok) {
      logError({ code: ErrorCode.EMAIL_SEND, detail: `status=${response.status} to=${msg.to}` });
    }
  } catch (error) {
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Send registration confirmation + admin notification emails.
 * Silently skips if email is not configured.
 */
export const sendRegistrationEmails = async (
  entries: RegistrationEntry[],
  currency: string,
): Promise<void> => {
  const config = await getEmailConfig();
  if (!config) return;

  const businessEmail = await getBusinessEmailFromDb();
  const ticketUrl = buildTicketUrl(entries);
  const replyTo = businessEmail || undefined;

  const confirmation = registrationConfirmation(entries, currency, ticketUrl);
  const promises: Promise<void>[] = [
    sendEmail(config, { to: entries[0]!.attendee.email, ...confirmation, replyTo }),
  ];

  if (businessEmail) {
    const notification = adminNotification(entries, currency);
    promises.push(
      sendEmail(config, { to: businessEmail, ...notification, replyTo: entries[0]!.attendee.email }),
    );
  }

  await Promise.allSettled(promises);
};

/** Send a test email to the business email address. */
export const sendTestEmail = async (config: EmailConfig, to: string): Promise<void> => {
  await sendEmail(config, {
    to,
    subject: "Test email from your ticket system",
    html: "<p>This is a test email. Your email configuration is working correctly.</p>",
    text: "This is a test email. Your email configuration is working correctly.",
  });
};
