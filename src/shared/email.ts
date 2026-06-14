/**
 * Email sending module
 * Sends registration emails via HTTP email APIs (Resend, Postmark, SendGrid, Mailgun)
 */

import { chunk, lazyRef, map } from "#fp";
import { toBase64 } from "#shared/crypto/utils.ts";
import { settings } from "#shared/db/settings.ts";
import {
  buildTemplateData,
  renderEmailContent,
} from "#shared/email-renderer.ts";
import { getEnv } from "#shared/env.ts";
import { type FetchResult, fetchText } from "#shared/fetch.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { generateSvgTicket, type SvgTicketData } from "#shared/svg-ticket.ts";
import { buildCheckinUrl, buildTicketUrl } from "#shared/ticket-url.ts";
import type { WebhookAttendee, WebhookEvent } from "#shared/webhook.ts";

/** Event data needed for registration pipeline (extends webhook event with display + assignment fields) */
export type EmailEvent = WebhookEvent & {
  active: boolean;
  date: string;
  hidden: boolean;
  location: string;
  purchase_only: boolean;
  assign_built_site: boolean;
  initial_site_months: number;
  event_type: "standard" | "daily";
  duration_days: number;
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
export const getEmailConfig = (): EmailConfig | null => {
  const provider = settings.email.provider;
  const apiKey = settings.email.apiKey;
  const from = settings.email.fromAddress || settings.businessEmail || "";
  if (!provider || !apiKey || !from) return null;
  return { apiKey, fromAddress: from, provider: provider as EmailProvider };
};

/** Read host-level email config from environment variables. Returns null if not fully configured. */
const getHostEmailConfigFromEnv = (): EmailConfig | null => {
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
  return { apiKey, fromAddress, provider };
};

const [getHostEmailOverride, setHostEmailOverride] = lazyRef<
  EmailConfig | null | undefined
>(() => undefined);

/** Get host-level email config. Uses test override if set, otherwise reads env vars. */
export const getHostEmailConfig = (): EmailConfig | null => {
  const override = getHostEmailOverride();
  return override !== undefined ? override : getHostEmailConfigFromEnv();
};

/** For testing: set host email config directly. Bypasses env vars to avoid races. */
export const setHostEmailConfigForTest = (config: EmailConfig | null): void =>
  setHostEmailOverride(config);

/** For testing: reset host email config to read from env vars. */
export const resetHostEmailConfig = (): void => setHostEmailOverride(undefined);

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

/** Provider using bearer-token auth (Resend, SendGrid, etc). */
const bearerProvider = (
  url: string,
  body: (config: EmailConfig, msg: EmailMessage) => unknown,
): ProviderRequest => provider(url, bearerAuth, body);

/** Map EmailMessage attachments into a provider-specific shape, or undefined. */
const mapAttachments = <T>(
  msg: EmailMessage,
  fn: (a: EmailAttachment) => T,
): T[] | undefined => msg.attachments?.map(fn);

const resendAttachment = (a: EmailAttachment) => ({
  content: a.content,
  filename: a.filename,
});

const sendgridAttachment = (a: EmailAttachment) => ({
  content: a.content,
  disposition: "attachment",
  filename: a.filename,
  type: a.contentType,
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
  "mailgun-eu": mailgun("api.eu.mailgun.net"),
  "mailgun-us": mailgun("api.mailgun.net"),
  postmark: provider(
    "https://api.postmarkapp.com/email",
    (apiKey) => ({
      Accept: "application/json",
      "X-Postmark-Server-Token": apiKey,
    }),
    (config, msg) => ({
      Attachments: msg.attachments?.map((a) => ({
        Content: a.content,
        ContentType: a.contentType,
        Name: a.filename,
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
  "mailgun-eu": "Mailgun (EU)",
  "mailgun-us": "Mailgun (US)",
  postmark: "Postmark",
  resend: "Resend",
  sendgrid: "SendGrid",
};

/** POST a JSON body with provider headers, eagerly reading the response. */
const postJson = (
  url: string,
  headers: Headers,
  body: unknown,
): Promise<FetchResult> =>
  fetchText(url, {
    body: JSON.stringify(body),
    headers: { ...headers, "Content-Type": "application/json" },
    method: "POST",
  });

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
    const { ok, status } =
      body instanceof FormData
        ? await fetchText(url, { body, headers, method: "POST" })
        : await postJson(url, headers, body);
    if (!ok) {
      logError({
        code: ErrorCode.EMAIL_SEND,
        detail: `status=${status} to=${msg.to}`,
      });
    }
    return status;
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
  attendeeDate: entry.attendee.date,
  checkinUrl: buildCheckinUrl(entry.attendee.ticket_token),
  currency,
  eventDate: entry.event.date,
  eventLocation: entry.event.location,
  eventName: entry.event.name,
  pricePaid: entry.attendee.price_paid,
  purchaseOnly: entry.event.purchase_only,
  quantity: entry.attendee.quantity,
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
    content: toBase64(new TextEncoder().encode(svg)),
    contentType: "image/svg+xml",
    filename: entries.length === 1 ? "ticket.svg" : `ticket-${i + 1}.svg`,
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
  const config = (await getEmailConfig()) ?? getHostEmailConfig();
  if (!config) return;

  const attendeeEmail = entries[0]?.attendee.email;
  const businessEmail = settings.businessEmail;
  const ticketUrl = buildTicketUrl(entries);
  const data = buildTemplateData(entries, currency, ticketUrl);
  const promises: Promise<number | undefined>[] = [];

  if (attendeeEmail) {
    const replyTo = businessEmail || undefined;
    const [confirmation, attachments] = await Promise.all([
      renderEmailContent("confirmation", data),
      buildTicketAttachments(entries, currency),
    ]);
    promises.push(
      sendEmail(config, {
        to: attendeeEmail,
        ...confirmation,
        attachments,
        replyTo,
      }),
    );
  }

  if (businessEmail) {
    const notification = await renderEmailContent("admin", data);
    promises.push(
      sendEmail(config, {
        to: businessEmail,
        ...notification,
        replyTo: attendeeEmail || undefined,
      }),
    );
  }

  await Promise.allSettled(promises);
};

// ---------------------------------------------------------------------------
// Bulk sending
//
// Bulk email only supports providers with a true batch endpoint — one HTTP
// request carries many independent messages. Sending one request per recipient
// would blow the edge runtime's per-invocation sub-request budget, so providers
// without a batch API are intentionally unsupported for bulk (the admin UI
// falls back to a mailto: link). New batch providers can be added to the
// registry below; the rest of the system keys off it.
// ---------------------------------------------------------------------------

/** A single message in a bulk send: recipient plus its (already personalized) bodies. */
export type BulkEmailMessage = { to: string; html: string; text: string };

/** Builds the HTTP request for one batch of bulk messages. */
type BulkBatchBuilder = (
  config: EmailConfig,
  subject: string,
  batch: BulkEmailMessage[],
) => [url: string, headers: Headers, body: unknown];

type BulkProviderSpec = {
  /** Maximum messages the provider accepts in a single batch request. */
  maxBatchSize: number;
  build: BulkBatchBuilder;
};

const BULK_PROVIDERS = {
  postmark: {
    build: (config, subject, batch) => [
      "https://api.postmarkapp.com/email/batch",
      { Accept: "application/json", "X-Postmark-Server-Token": config.apiKey },
      batch.map((m) => ({
        From: config.fromAddress,
        HtmlBody: m.html,
        Subject: subject,
        TextBody: m.text,
        To: m.to,
      })),
    ],
    maxBatchSize: 500,
  },
  resend: {
    build: (config, subject, batch) => [
      "https://api.resend.com/emails/batch",
      bearerAuth(config.apiKey),
      batch.map((m) => ({
        from: config.fromAddress,
        html: m.html,
        subject,
        text: m.text,
        to: [m.to],
      })),
    ],
    maxBatchSize: 100,
  },
} as const satisfies Record<string, BulkProviderSpec>;

/** Providers that support bulk sending, derived from the registry. */
export type BulkEmailProvider = keyof typeof BULK_PROVIDERS;

/** Set of bulk-capable provider names (subset of EmailProvider). */
export const BULK_EMAIL_PROVIDERS: ReadonlySet<EmailProvider> = new Set(
  Object.keys(BULK_PROVIDERS) as EmailProvider[],
);

/** Type guard: does this provider support bulk sending? */
export const isBulkEmailProvider = (
  value: string,
): value is BulkEmailProvider => Object.hasOwn(BULK_PROVIDERS, value);

/** Outcome of a bulk send: how many messages were attempted, in how many batches, and how many landed in failed batches. */
export type BulkSendResult = {
  attempted: number;
  batches: number;
  failed: number;
};

/**
 * Send a batch of personalized messages via a bulk-capable provider.
 * Chunks to the provider's batch limit and POSTs each chunk. Logs (never
 * throws) on a non-OK batch response; the whole batch's recipients count as
 * failed. Callers must pass a provider for which `isBulkEmailProvider` is true.
 */
export const sendBulkEmails = async (
  config: EmailConfig,
  provider: BulkEmailProvider,
  subject: string,
  messages: BulkEmailMessage[],
): Promise<BulkSendResult> => {
  const spec = BULK_PROVIDERS[provider];
  const batches = chunk(spec.maxBatchSize)(messages);
  let failed = 0;
  for (const batch of batches) {
    const [url, headers, body] = spec.build(config, subject, batch);
    const { ok, status } = await postJson(url, headers, body);
    if (!ok) {
      failed += batch.length;
      logError({
        code: ErrorCode.EMAIL_SEND,
        detail: `bulk status=${status} provider=${provider} count=${batch.length}`,
      });
    }
  }
  return { attempted: messages.length, batches: batches.length, failed };
};

/** Send a test email to the business email address. Returns HTTP status or undefined on non-HTTP errors. */
export const sendTestEmail = async (
  config: EmailConfig,
  to: string,
): Promise<number | undefined> => {
  return await sendEmail(config, {
    html: "<p>This is a test email. Your email configuration is working correctly.</p>",
    subject: "Test email from your ticket system",
    text: "This is a test email. Your email configuration is working correctly.",
    to,
  });
};
