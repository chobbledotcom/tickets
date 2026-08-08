/**
 * Email provider configuration and single-message delivery.
 */

import * as v from "valibot";
import { lazyRef } from "#fp";
import { t } from "#i18n";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import { errorMessage } from "#shared/error-message.ts";
import { type FetchResult, fetchText } from "#shared/fetch.ts";
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

const [getHostEmailOverride, setHostEmailOverride] = lazyRef<
  EmailConfig | null | undefined
>(() => undefined);

export const getHostEmailConfig = (): EmailConfig | null => {
  const override = getHostEmailOverride();
  return override !== undefined ? override : getHostEmailConfigFromEnv();
};

export const setHostEmailConfigForTest = (config: EmailConfig | null): void =>
  setHostEmailOverride(config);

export const resetHostEmailConfig = (): void => setHostEmailOverride(undefined);

export const getActiveEmailConfig = (): EmailConfig | null => {
  const siteConfig = getEmailConfig();
  return siteConfig !== null ? siteConfig : getHostEmailConfig();
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
): Promise<FetchResult> => {
  const isFormData = body instanceof FormData;
  return fetchText(url, {
    body: isFormData ? body : JSON.stringify(body),
    headers: isFormData
      ? headers
      : { ...headers, "Content-Type": "application/json" },
    method: "POST",
  });
};

export const sendEmailRequest = (request: EmailRequest): Promise<FetchResult> =>
  postBody(...request);

type EmailDeliveryResult =
  | { delivered: true; status: number }
  | { delivered: false; detail: string; status: number | undefined };

const failedEmailDelivery = (error: unknown): EmailDeliveryResult => ({
  delivered: false,
  detail: errorMessage(error),
  status: undefined,
});

const emailDelivery =
  (recover: (error: unknown) => EmailDeliveryResult) =>
  async (
    config: EmailConfig,
    msg: EmailMessage,
  ): Promise<EmailDeliveryResult> => {
    const buildRequest = PROVIDERS[config.provider];
    try {
      const { ok, status } = await sendEmailRequest(buildRequest(config, msg));
      return ok
        ? { delivered: true, status }
        : {
            delivered: false,
            detail: `provider=${config.provider} status=${status}`,
            status,
          };
    } catch (error) {
      return recover(error);
    }
  };

const reportedEmailDelivery = emailDelivery(failedEmailDelivery);

export const deliverRegistrationEmail: (
  config: EmailConfig,
  msg: EmailMessage,
) => Promise<EmailDeliveryResult> = emailDelivery((error) => {
  if (!(error instanceof TypeError)) throw error;
  return failedEmailDelivery(error);
});

export const sendEmail = async (
  config: EmailConfig,
  msg: EmailMessage,
): Promise<number | undefined> => {
  const delivery = await reportedEmailDelivery(config, msg);
  if (!delivery.delivered) {
    logError({ code: ErrorCode.EMAIL_SEND, detail: delivery.detail });
  }
  return delivery.status;
};

export const sendTestEmail = async (
  config: EmailConfig,
  to: ValidEmail,
): Promise<number | undefined> =>
  await sendEmail(config, {
    html: `<p>${t("fields.email.test_body")}</p>`,
    subject: t("fields.email.test_subject"),
    text: t("fields.email.test_body"),
    to,
  });
