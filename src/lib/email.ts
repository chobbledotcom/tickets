/**
 * Email sending module
 * Sends registration emails via HTTP email APIs (Resend, Postmark, SendGrid, Mailgun)
 */

import { map } from "#fp";
import { getBusinessEmailFromDb } from "#lib/business-email.ts";
import { getAllowedDomain } from "#lib/config.ts";
import {
  getEmailApiKeyFromDb,
  getEmailFromAddressFromDb,
  getEmailProviderFromDb,
} from "#lib/db/settings.ts";
import { buildTemplateData, renderEmailContent } from "#lib/email-renderer.ts";
import { getEnv } from "#lib/env.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { generateSvgTicket, type SvgTicketData } from "#lib/svg-ticket.ts";
import { buildTicketUrl } from "#lib/ticket-url.ts";
import type { WebhookAttendee, WebhookEvent } from "#lib/webhook.ts";

/** Event data needed for email rendering (extends webhook event with display fields) */
export type EmailEvent = WebhookEvent & {
  date: string;
  location: string;
};

/** Attendee + event pair for email rendering */
export type EmailEntry = {
  event: EmailEvent;
  attendee: WebhookAttendee;
};

/** A base64-encoded email attachment */
export type EmailAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
};

export type EmailConfig = {
  provider: EmailProvider;
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
  return { provider: provider as EmailProvider, apiKey, fromAddress: from };
};

/** Read host-level email config from environment variables. Returns null if not fully configured. */
export const getHostEmailConfig = (): EmailConfig | null => {
  const provider = getEnv("HOST_EMAIL_PROVIDER");
  const apiKey = getEnv("HOST_EMAIL_API_KEY");
  const fromAddress = getEnv("HOST_EMAIL_FROM_ADDRESS");
  if (!provider || !apiKey || !fromAddress) return null;
  if (!isEmailProvider(provider)) {
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: `invalid HOST_EMAIL_PROVIDER: "${provider}"`,
    });
    return null;
  }
  return { provider, apiKey, fromAddress };
};

type Headers = Record<string, string>;
type ProviderRequest = (
  config: EmailConfig,
  msg: EmailMessage,
) => [url: string, headers: Headers, body: unknown];

const provider =
  (
    url: string | ((config: EmailConfig) => string),
    headers: (apiKey: string) => Headers,
    body: (config: EmailConfig, msg: EmailMessage) => unknown,
  ): ProviderRequest =>
  (config, msg) => [
    typeof url === "string" ? url : url(config),
    headers(config.apiKey),
    body(config, msg),
  ];

const bearerAuth = (apiKey: string): Headers => ({
  Authorization: `Bearer ${apiKey}`,
});

const mailgunBody = (config: EmailConfig, msg: EmailMessage): FormData => {
  const form = new FormData();
  form.append("from", config.fromAddress);
  form.append("to", msg.to);
  form.append("subject", msg.subject);
  form.append("html", msg.html);
  form.append("text", msg.text);
  if (msg.replyTo) form.append("h:Reply-To", msg.replyTo);
  for (const a of msg.attachments ?? []) {
    const bytes = Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0));
    form.append(
      "attachment",
      new Blob([bytes], { type: a.contentType }),
      a.filename,
    );
  }
  return form;
};

const mailgun = (host: string) =>
  provider(
    (config) =>
      `https://${host}/v3/${config.fromAddress.split("@")[1]}/messages`,
    (apiKey) => ({ Authorization: `Basic ${btoa(`api:${apiKey}`)}` }),
    mailgunBody,
  );

const PROVIDERS = {
  resend: provider(
    "https://api.resend.com/emails",
    bearerAuth,
    (config, msg) => ({
      from: config.fromAddress,
      to: [msg.to],
      reply_to: msg.replyTo,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
    }),
  ),
  postmark: provider(
    "https://api.postmarkapp.com/email",
    (apiKey) => ({
      "X-Postmark-Server-Token": apiKey,
      Accept: "application/json",
    }),
    (config, msg) => ({
      From: config.fromAddress,
      To: msg.to,
      ReplyTo: msg.replyTo,
      Subject: msg.subject,
      HtmlBody: msg.html,
      TextBody: msg.text,
      Attachments: msg.attachments?.map((a) => ({
        Name: a.filename,
        Content: a.content,
        ContentType: a.contentType,
      })),
    }),
  ),
  sendgrid: provider(
    "https://api.sendgrid.com/v3/mail/send",
    bearerAuth,
    (config, msg) => ({
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: config.fromAddress },
      reply_to: msg.replyTo ? { email: msg.replyTo } : undefined,
      subject: msg.subject,
      content: [
        { type: "text/plain", value: msg.text },
        { type: "text/html", value: msg.html },
      ],
      attachments: msg.attachments?.map((a) => ({
        content: a.content,
        filename: a.filename,
        type: a.contentType,
        disposition: "attachment",
      })),
    }),
  ),
  "mailgun-us": mailgun("api.mailgun.net"),
  "mailgun-eu": mailgun("api.eu.mailgun.net"),
} as const satisfies Record<string, ProviderRequest>;

/** Union of all supported email provider keys, derived from the PROVIDERS map */
export type EmailProvider = keyof typeof PROVIDERS;

/** Valid provider names, derived from the PROVIDERS map */
export const VALID_EMAIL_PROVIDERS: ReadonlySet<EmailProvider> = new Set(
  Object.keys(PROVIDERS) as EmailProvider[],
);

/** Type guard: checks if a string is a valid EmailProvider */
export const isEmailProvider = (value: string): value is EmailProvider =>
  (VALID_EMAIL_PROVIDERS as ReadonlySet<string>).has(value);

/** Display labels for email providers — keys must match EmailProvider */
export const EMAIL_PROVIDER_LABELS: Record<EmailProvider, string> = {
  resend: "Resend",
  postmark: "Postmark",
  sendgrid: "SendGrid",
  "mailgun-us": "Mailgun (US)",
  "mailgun-eu": "Mailgun (EU)",
};

/** Send a single email via the configured provider. Logs errors, never throws. Returns HTTP status or undefined on non-HTTP errors. */
export const sendEmail = async (
  config: EmailConfig,
  msg: EmailMessage,
): Promise<number | undefined> => {
  const buildRequest = PROVIDERS[config.provider];
  if (!buildRequest) {
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: `unknown provider: ${config.provider}`,
    });
    return undefined;
  }
  try {
    const [url, headers, body] = buildRequest(config, msg);
    const isFormData = body instanceof FormData;
    const response = await fetch(url, {
      method: "POST",
      headers: isFormData
        ? headers
        : { ...headers, "Content-Type": "application/json" },
      body: isFormData ? body : JSON.stringify(body),
    });
    if (!response.ok) {
      logError({
        code: ErrorCode.EMAIL_SEND,
        detail: `status=${response.status} to=${msg.to}`,
      });
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

/** Build SVG ticket data from an email entry (non-PII only) */
export const buildSvgTicketData = (
  entry: EmailEntry,
  currency: string,
): SvgTicketData => ({
  eventName: entry.event.name,
  eventDate: entry.event.date,
  eventLocation: entry.event.location,
  attendeeDate: entry.attendee.date,
  quantity: entry.attendee.quantity,
  pricePaid: entry.attendee.price_paid,
  currency,
  checkinUrl: `https://${getAllowedDomain()}/checkin/${entry.attendee.ticket_token}`,
});

/** Generate SVG ticket attachments for all entries */
export const buildTicketAttachments = async (
  entries: EmailEntry[],
  currency: string,
): Promise<EmailAttachment[]> => {
  const ticketDataList = map((entry: EmailEntry) =>
    buildSvgTicketData(entry, currency),
  )(entries);
  const svgs = await Promise.all(
    ticketDataList.map((data) => generateSvgTicket(data)),
  );
  return svgs.map((svg, i) => ({
    filename: entries.length === 1 ? "ticket.svg" : `ticket-${i + 1}.svg`,
    content: btoa(svg),
    contentType: "image/svg+xml",
  }));
};

/**
 * Send registration confirmation + admin notification emails.
 * Entries is an array because one registration can cover multiple events.
 * Silently skips if email is not configured.
 * Attaches one SVG ticket per entry to the confirmation email.
 */
export const sendRegistrationEmails = async (
  entries: EmailEntry[],
  currency: string,
): Promise<void> => {
  const attendeeEmail = entries[0]?.attendee.email;
  if (!attendeeEmail) return;

  const config = (await getEmailConfig()) ?? getHostEmailConfig();
  if (!config) return;

  const businessEmail = await getBusinessEmailFromDb();
  const ticketUrl = buildTicketUrl(entries);
  const replyTo = businessEmail || undefined;
  const data = buildTemplateData(entries, currency, ticketUrl);

  const [confirmation, attachments] = await Promise.all([
    renderEmailContent("confirmation", data),
    buildTicketAttachments(entries, currency),
  ]);
  const promises: Promise<number | undefined>[] = [
    sendEmail(config, {
      to: attendeeEmail,
      ...confirmation,
      replyTo,
      attachments,
    }),
  ];

  if (businessEmail) {
    const notification = await renderEmailContent("admin", data);
    promises.push(
      sendEmail(config, {
        to: businessEmail,
        ...notification,
        replyTo: attendeeEmail,
      }),
    );
  }

  await Promise.allSettled(promises);
};

/** Send a test email to the business email address. Returns HTTP status or undefined on non-HTTP errors. */
export const sendTestEmail = async (
  config: EmailConfig,
  to: string,
): Promise<number | undefined> => {
  return await sendEmail(config, {
    to,
    subject: "Test email from your ticket system",
    html: "<p>This is a test email. Your email configuration is working correctly.</p>",
    text: "This is a test email. Your email configuration is working correctly.",
  });
};
