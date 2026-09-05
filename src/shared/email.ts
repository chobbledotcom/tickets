/**
 * Email provider configuration and single-message delivery.
 */

import * as v from "valibot";
import { settings } from "#db/settings.ts";
/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import { getEnv } from "#shared/env.ts";
/* jscpd:ignore-end */
import { errorMessage } from "#shared/error-message.ts";
import { apiErrorMessage, type FetchResult, fetchText } from "#shared/fetch.ts";
import { createHostConfigOverride } from "#shared/host-config.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  emailHost,
  parseEmail,
  type ValidEmail,
} from "#shared/validation/email.ts";
import { guardFor } from "#shared/validation/guard.ts";
import type { WebhookAttendee, WebhookListing } from "#shared/webhook.ts";

export type EmailListing = WebhookListing & {
  active: boolean;
  date: string;
  hidden: boolean;
  location: string;
  purchase_only: boolean;
  assign_built_site: boolean;
  initial_site_months: number;
  listing_type: "standard" | "daily";
};

export interface EmailEntry {
  attendee: WebhookAttendee;
  listing: EmailListing;
}

export interface EmailAttachment {
  content: string;
  contentType: string;
  filename: string;
}

export interface EmailMessage {
  attachments?: EmailAttachment[] | undefined;
  html: string;
  replyTo?: ValidEmail | undefined;
  subject: string;
  text: string;
  to: ValidEmail;
}

export interface EmailConfig {
  apiKey: string;
  fromAddress: ValidEmail;
  provider: EmailProvider;
}

export const getEmailConfig = (): EmailConfig | null => {
  const provider = settings.email.provider;
  const apiKey = settings.email.apiKey;
  const fromAddress = parseEmail(
    settings.email.fromAddress || settings.businessEmail || "",
  );
  if (!provider) return null;
  if (!isEmailProvider(provider)) {
    throw new Error(`Unknown stored email provider: ${provider}`);
  }
  if (!apiKey || !fromAddress) return null;
  return { apiKey, fromAddress, provider };
};

const getHostEmailConfigFromEnv = (): EmailConfig | null => {
  const provider = getEnv("HOST_EMAIL_PROVIDER");
  const apiKey = getEnv("HOST_EMAIL_API_KEY");
  const fromAddress = parseEmail(getEnv("HOST_EMAIL_FROM_ADDRESS") ?? "");
  if (!provider || !apiKey || !fromAddress) return null;
  if (!isEmailProvider(provider)) {
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: `invalid HOST_EMAIL_PROVIDER: "${provider}"`,
    });
    return null;
  }
  return { apiKey, fromAddress, provider };
};

/** The host machine's own email credentials, read from its environment, with
 *  the hook a test uses to stand a different set in front of them. */
export const hostEmail = createHostConfigOverride(getHostEmailConfigFromEnv);

export const getActiveEmailConfig = (): EmailConfig | null => {
  const siteConfig = getEmailConfig();
  return siteConfig !== null ? siteConfig : hostEmail.getHostConfig();
};

type Headers = Record<string, string>;
export type EmailRequest = [url: string, headers: Headers, body: unknown];
type EmailProviderFn<Result> = (
  config: EmailConfig,
  msg: EmailMessage,
) => Result;
type ProviderRequest = EmailProviderFn<EmailRequest>;

const provider =
  (
    url: string | ((config: EmailConfig) => string),
    headers: (apiKey: string) => Headers,
    body: EmailProviderFn<unknown>,
  ): ProviderRequest =>
  (config, msg) => [
    typeof url === "string" ? url : url(config),
    headers(config.apiKey),
    body(config, msg),
  ];

export const bearerAuth = (apiKey: string): Headers => ({
  Authorization: `Bearer ${apiKey}`,
});

const bearerProvider = (
  url: string,
  body: EmailProviderFn<unknown>,
): ProviderRequest => provider(url, bearerAuth, body);

const mapAttachments = <T>(
  msg: EmailMessage,
  fn: (attachment: EmailAttachment) => T,
): T[] | undefined => msg.attachments?.map(fn);

const resendAttachment = (attachment: EmailAttachment) => ({
  content: attachment.content,
  filename: attachment.filename,
});

const sendgridAttachment = (attachment: EmailAttachment) => ({
  content: attachment.content,
  disposition: "attachment",
  filename: attachment.filename,
  type: attachment.contentType,
});

export const mailgunForm = (config: EmailConfig): FormData => {
  const form = new FormData();
  form.append("from", config.fromAddress);
  return form;
};

const mailgunBody = (config: EmailConfig, msg: EmailMessage): FormData => {
  const form = mailgunForm(config);
  form.append("to", msg.to);
  form.append("subject", msg.subject);
  form.append("html", msg.html);
  form.append("text", msg.text);
  if (msg.replyTo) form.append("h:Reply-To", msg.replyTo);
  for (const attachment of msg.attachments ?? []) {
    const bytes = Uint8Array.fromBase64(attachment.content);
    form.append(
      "attachment",
      new Blob([bytes], { type: attachment.contentType }),
      attachment.filename,
    );
  }
  return form;
};

const mailgun = (host: string): ProviderRequest =>
  provider(
    (config) => `https://${host}/v3/${emailHost(config.fromAddress)}/messages`,
    (apiKey) => ({ Authorization: `Basic ${btoa(`api:${apiKey}`)}` }),
    mailgunBody,
  );

const PROVIDERS = {
  "mailgun-eu": mailgun("api.eu.mailgun.net"),
  "mailgun-us": mailgun("api.mailgun.net"),
  postmark: provider(
    "https://api.postmarkapp.com/email",
    (apiKey) => ({
      Accept: "application/json",
      "X-Postmark-Server-Token": apiKey,
    }),
    (config, msg) => ({
      Attachments: msg.attachments?.map((attachment) => ({
        Content: attachment.content,
        ContentType: attachment.contentType,
        Name: attachment.filename,
      })),
      From: config.fromAddress,
      HtmlBody: msg.html,
      ReplyTo: msg.replyTo,
      Subject: msg.subject,
      TextBody: msg.text,
      To: msg.to,
    }),
  ),
  resend: bearerProvider("https://api.resend.com/emails", (config, msg) => ({
    attachments: mapAttachments(msg, resendAttachment),
    from: config.fromAddress,
    html: msg.html,
    reply_to: msg.replyTo,
    subject: msg.subject,
    text: msg.text,
    to: [msg.to],
  })),
  sendgrid: bearerProvider(
    "https://api.sendgrid.com/v3/mail/send",
    (config, msg) => ({
      attachments: mapAttachments(msg, sendgridAttachment),
      content: [
        { type: "text/plain", value: msg.text },
        { type: "text/html", value: msg.html },
      ],
      from: { email: config.fromAddress },
      personalizations: [{ to: [{ email: msg.to }] }],
      reply_to: msg.replyTo ? { email: msg.replyTo } : undefined,
      subject: msg.subject,
    }),
  ),
} as const satisfies Record<string, ProviderRequest>;

export type EmailProvider = keyof typeof PROVIDERS;

const EmailProviderSchema = v.picklist(
  Object.keys(PROVIDERS) as [EmailProvider, ...EmailProvider[]],
);

export const VALID_EMAIL_PROVIDERS = EmailProviderSchema.options;

export const isEmailProvider = guardFor(EmailProviderSchema);

export const EMAIL_PROVIDER_LABELS: Record<EmailProvider, string> = {
  "mailgun-eu": "Mailgun (EU)",
  "mailgun-us": "Mailgun (US)",
  postmark: "Postmark",
  resend: "Resend",
  sendgrid: "SendGrid",
};

const postBody = (
  url: string,
  headers: Headers,
  body: unknown,
  signal: AbortSignal | null,
): Promise<FetchResult> => {
  const isFormData = body instanceof FormData;
  return fetchText(url, {
    body: isFormData ? body : JSON.stringify(body),
    headers: isFormData
      ? headers
      : { ...headers, "Content-Type": "application/json" },
    method: "POST",
    signal,
  });
};

/** `signal` cancels the request while it is in flight. `null` is the
 * everyday case: a send that nothing cancels. */
export const sendEmailRequest = (
  request: EmailRequest,
  signal: AbortSignal | null = null,
): Promise<FetchResult> => postBody(...request, signal);

export type EmailDeliveryResult =
  | { delivered: true; status: number }
  | {
      delivered: false;
      /** For the console line: the provider and the status alone. */
      detail: string;
      /** The provider's own error message, safe to show to the operator.
       * Empty when there is no usable message — a network failure has no
       * reply, and some replies carry none — so callers branch on it. */
      reason: string;
      status: number | undefined;
    };

/** Deliver one message with a config — the shape every sender shares. */
type EmailDeliveryFn = (
  config: EmailConfig,
  msg: EmailMessage,
  signal?: AbortSignal | null,
) => Promise<EmailDeliveryResult>;

const failedEmailDelivery = (error: unknown): EmailDeliveryResult => ({
  delivered: false,
  detail: errorMessage(error),
  reason: "",
  status: undefined,
});

/** Keys the email providers use for the message in an error reply:
 * Resend and Mailgun `message`, Postmark `Message`, SendGrid `errors`. */
const PROVIDER_ERROR_KEYS = ["message", "Message", "errors", "error"];

/** How much of a provider's reply can enter a log line, a flash message, or
 * the activity log, so a verbose body cannot flood any of them. */
const MAX_REASON_LENGTH = 300;

/** Cut a provider's reply to that length, marking the cut. */
export const cappedReply = (text: string): string =>
  text.length > MAX_REASON_LENGTH
    ? `${text.slice(0, MAX_REASON_LENGTH)}...`
    : text;

/** Any email-shaped token in a reply is an address that must not reach the
 * logs — a provider can echo the recipient, the sender, or an account
 * address the send never named. Greedy on purpose: better to blank an odd
 * token than to let an address through. */
const EMAIL_SHAPED = /\S+@\S+/g;

/** Pull the reason out of a provider's error reply: the parsed message or the
 * raw body, on one line, capped, and with every email-shaped value blanked.
 * Empty when the reply body says nothing. */
export const failureReason = (text: string): string => {
  const withoutAddresses = apiErrorMessage(text, PROVIDER_ERROR_KEYS).replace(
    EMAIL_SHAPED,
    "[redacted]",
  );
  return cappedReply(withoutAddresses.replace(/\s+/g, " ").trim());
};

const emailDelivery =
  (recover: (error: unknown) => EmailDeliveryResult): EmailDeliveryFn =>
  async (config, msg, signal = null) => {
    const buildRequest = PROVIDERS[config.provider];
    try {
      const { ok, status, text } = await sendEmailRequest(
        buildRequest(config, msg),
        signal,
      );
      if (ok) return { delivered: true, status };
      return {
        delivered: false,
        detail: `provider=${config.provider} status=${status}`,
        reason: failureReason(text),
        status,
      };
    } catch (error) {
      return recover(error);
    }
  };

const reportedEmailDelivery = emailDelivery(failedEmailDelivery);

export const deliverRegistrationEmail: EmailDeliveryFn = emailDelivery(
  (error) => {
    if (!(error instanceof TypeError)) throw error;
    return failedEmailDelivery(error);
  },
);

export const sendEmail: EmailDeliveryFn = async (config, msg, signal) => {
  const delivery = await reportedEmailDelivery(config, msg, signal);
  if (!delivery.delivered) {
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: delivery.detail,
      operatorDetail: delivery.reason || undefined,
    });
  }
  return delivery;
};

export const sendTestEmail = async (
  config: EmailConfig,
  to: ValidEmail,
): Promise<EmailDeliveryResult> =>
  await sendEmail(config, {
    html: `<p>${t("fields.email.test_body")}</p>`,
    subject: t("fields.email.test_subject"),
    text: t("fields.email.test_body"),
    to,
  });
