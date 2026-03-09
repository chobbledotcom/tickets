/**
 * Email sending module
 * Sends registration emails via HTTP email APIs (Resend, Postmark, SendGrid, Mailgun)
 */

import { getBusinessEmailFromDb } from "#lib/business-email.ts";
import {
  getEmailApiKeyFromDb,
  getEmailFromAddressFromDb,
  getEmailProviderFromDb,
} from "#lib/db/settings.ts";
import { buildTemplateData, renderEmailContent } from "#lib/email-renderer.ts";
import { getEnv } from "#lib/env.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { buildTicketUrl } from "#lib/ticket-url.ts";
import type { RegistrationEntry } from "#lib/webhook.ts";

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

/** Read host-level email config from environment variables. Returns null if not fully configured. */
export const getHostEmailConfig = (): EmailConfig | null => {
  const provider = getEnv("HOST_EMAIL_PROVIDER");
  const apiKey = getEnv("HOST_EMAIL_API_KEY");
  const fromAddress = getEnv("HOST_EMAIL_FROM_ADDRESS");
  if (!provider || !apiKey || !fromAddress) return null;
  return { provider, apiKey, fromAddress };
};

/** Build provider-specific request: [url, extra-headers, body] */
type ProviderRequest = (config: EmailConfig, msg: EmailMessage) => [string, Record<string, string>, unknown];

const resendRequest: ProviderRequest = (config, msg) => [
  "https://api.resend.com/emails",
  { "Authorization": `Bearer ${config.apiKey}` },
  {
    from: config.fromAddress,
    to: [msg.to],
    reply_to: msg.replyTo,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  },
];

const postmarkRequest: ProviderRequest = (config, msg) => [
  "https://api.postmarkapp.com/email",
  { "X-Postmark-Server-Token": config.apiKey, "Accept": "application/json" },
  {
    From: config.fromAddress,
    To: msg.to,
    ReplyTo: msg.replyTo,
    Subject: msg.subject,
    HtmlBody: msg.html,
    TextBody: msg.text,
  },
];

const sendgridRequest: ProviderRequest = (config, msg) => [
  "https://api.sendgrid.com/v3/mail/send",
  { "Authorization": `Bearer ${config.apiKey}` },
  {
    personalizations: [{ to: [{ email: msg.to }] }],
    from: { email: config.fromAddress },
    reply_to: msg.replyTo ? { email: msg.replyTo } : undefined,
    subject: msg.subject,
    content: [
      { type: "text/plain", value: msg.text },
      { type: "text/html", value: msg.html },
    ],
  },
];

const mailgunRequest = (host: string): ProviderRequest => (config, msg) => {
  const domain = config.fromAddress.split("@")[1];
  const form = new FormData();
  form.append("from", config.fromAddress);
  form.append("to", msg.to);
  form.append("subject", msg.subject);
  form.append("html", msg.html);
  form.append("text", msg.text);
  if (msg.replyTo) form.append("h:Reply-To", msg.replyTo);
  return [
    `https://${host}/v3/${domain}/messages`,
    { "Authorization": `Basic ${btoa("api:" + config.apiKey)}` },
    form,
  ];
};

const PROVIDERS: Record<string, ProviderRequest> = {
  resend: resendRequest,
  postmark: postmarkRequest,
  sendgrid: sendgridRequest,
  "mailgun-us": mailgunRequest("api.mailgun.net"),
  "mailgun-eu": mailgunRequest("api.eu.mailgun.net"),
};

/** Valid provider names, derived from the PROVIDERS map */
export const VALID_EMAIL_PROVIDERS: ReadonlySet<string> = new Set(Object.keys(PROVIDERS));

/** Display labels for email providers */
export const EMAIL_PROVIDER_LABELS: Record<string, string> = {
  resend: "Resend",
  postmark: "Postmark",
  sendgrid: "SendGrid",
  "mailgun-us": "Mailgun (US)",
  "mailgun-eu": "Mailgun (EU)",
};

/** Send a single email via the configured provider. Logs errors, never throws. Returns HTTP status or undefined on non-HTTP errors. */
export const sendEmail = async (config: EmailConfig, msg: EmailMessage): Promise<number | undefined> => {
  const buildRequest = PROVIDERS[config.provider];
  if (!buildRequest) {
    logError({ code: ErrorCode.EMAIL_SEND, detail: `unknown provider: ${config.provider}` });
    return undefined;
  }
  try {
    const [url, headers, body] = buildRequest(config, msg);
    const isFormData = body instanceof FormData;
    const response = await fetch(url, {
      method: "POST",
      headers: isFormData ? headers : { ...headers, "Content-Type": "application/json" },
      body: isFormData ? body : JSON.stringify(body),
    });
    if (!response.ok) {
      logError({ code: ErrorCode.EMAIL_SEND, detail: `status=${response.status} to=${msg.to}` });
    }
    return response.status;
  } catch (error) {
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

/**
 * Send registration confirmation + admin notification emails.
 * Entries is an array because one registration can cover multiple events.
 * Silently skips if email is not configured.
 */
export const sendRegistrationEmails = async (
  entries: RegistrationEntry[],
  currency: string,
): Promise<void> => {
  const config = await getEmailConfig() ?? getHostEmailConfig();
  if (!config) return;

  const businessEmail = await getBusinessEmailFromDb();
  const ticketUrl = buildTicketUrl(entries);
  const replyTo = businessEmail || undefined;
  const data = buildTemplateData(entries, currency, ticketUrl);

  const confirmation = await renderEmailContent("confirmation", data);
  const promises: Promise<number | undefined>[] = [
    sendEmail(config, { to: entries[0]!.attendee.email, ...confirmation, replyTo }),
  ];

  if (businessEmail) {
    const notification = await renderEmailContent("admin", data);
    promises.push(
      sendEmail(config, { to: businessEmail, ...notification, replyTo: entries[0]!.attendee.email }),
    );
  }

  await Promise.allSettled(promises);
};

/** Send a test email to the business email address. Returns HTTP status or undefined on non-HTTP errors. */
export const sendTestEmail = async (config: EmailConfig, to: string): Promise<number | undefined> => {
  return await sendEmail(config, {
    to,
    subject: "Test email from your ticket system",
    html: "<p>This is a test email. Your email configuration is working correctly.</p>",
    text: "This is a test email. Your email configuration is working correctly.",
  });
};
