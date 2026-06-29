/**
 * Email sending module
 * Sends registration emails via HTTP email APIs (Resend, Postmark, SendGrid, Mailgun)
 */

import * as v from "valibot";
import { chunk, lazyRef, map } from "#fp";
import { t } from "#i18n";
import { toBase64 } from "#shared/crypto/utils.ts";
import type { PackageDisplay } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import {
  buildTemplateData,
  getPackageDisplayForEntries,
  renderEmailContent,
  sumEntryPrices,
  sumEntryQuantities,
} from "#shared/email-renderer.ts";
import { getEnv } from "#shared/env.ts";
import { type FetchResult, fetchText } from "#shared/fetch.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { generateSvgTicket, type SvgTicketData } from "#shared/svg-ticket.ts";
import { buildCheckinUrl, buildTicketUrl } from "#shared/ticket-url.ts";
import {
  emailHost,
  parseEmail,
  type ValidEmail,
} from "#shared/validation/email.ts";
import type { WebhookAttendee, WebhookListing } from "#shared/webhook.ts";

/** Listing data needed for registration pipeline (extends webhook listing with display + assignment fields) */
export type EmailListing = WebhookListing & {
  active: boolean;
  date: string;
  hidden: boolean;
  location: string;
  purchase_only: boolean;
  assign_built_site: boolean;
  initial_site_months: number;
  listing_type: "standard" | "daily";
  duration_days: number;
};

/** Attendee + listing pair for email rendering */
export type EmailEntry = {
  listing: EmailListing;
  attendee: WebhookAttendee;
};

/** A base64-encoded email attachment */
export type EmailAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export type EmailMessage = {
  to: ValidEmail;
  subject: string;
  html: string;
  text: string;
  replyTo?: ValidEmail | undefined;
  attachments?: EmailAttachment[] | undefined;
};

export type EmailConfig = {
  provider: EmailProvider;
  apiKey: string;
  fromAddress: ValidEmail;
};

/** Read email config from DB settings. Falls back to business email for
 * fromAddress. Returns null if not configured or the from address is invalid. */
export const getEmailConfig = (): EmailConfig | null => {
  const provider = settings.email.provider;
  const apiKey = settings.email.apiKey;
  const fromAddress = parseEmail(
    settings.email.fromAddress || settings.businessEmail || "",
  );
  if (!provider || !apiKey || !fromAddress) return null;
  return { apiKey, fromAddress, provider: provider as EmailProvider };
};

/** Read host-level email config from environment variables. Returns null if not
 * fully configured, the provider is unknown, or the from address is invalid. */
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
    const bytes = Uint8Array.fromBase64(a.content);
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

/**
 * Picklist schema for the supported email providers. Its options are derived
 * from the PROVIDERS map so the two can never drift, and it mirrors the
 * string-union picklists in types.ts (ContactFieldSchema, PaymentProviderSchema
 * …) — `EmailProviderSchema.options` + `v.is` replace the previous hand-rolled
 * Set + `.has()` guard.
 */
export const EmailProviderSchema = v.picklist(
  Object.keys(PROVIDERS) as [EmailProvider, ...EmailProvider[]],
);

/** Valid provider names (the picklist options), derived from the PROVIDERS map */
export const VALID_EMAIL_PROVIDERS = EmailProviderSchema.options;

/** Type guard: checks if a string is a valid EmailProvider */
export const isEmailProvider = (value: string): value is EmailProvider =>
  v.is(EmailProviderSchema, value);

/** Display labels for email providers — keys must match EmailProvider */
export const EMAIL_PROVIDER_LABELS: Record<EmailProvider, string> = {
  "mailgun-eu": "Mailgun (EU)",
  "mailgun-us": "Mailgun (US)",
  postmark: "Postmark",
  resend: "Resend",
  sendgrid: "SendGrid",
};

/** POST a body with provider headers, eagerly reading the response. FormData
 * (Mailgun) is sent as-is; everything else is JSON-encoded. */
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

/** POST a built provider request tuple `[url, headers, body]` and read the response. */
const sendRequest = (
  request: [url: string, headers: Headers, body: unknown],
): Promise<FetchResult> => postBody(...request);

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
    const { ok, status } = await sendRequest(buildRequest(config, msg));
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
  listingDate: entry.listing.date,
  listingLocation: entry.listing.location,
  listingName: entry.listing.name,
  pricePaid: entry.attendee.price_paid,
  purchaseOnly: entry.listing.purchase_only,
  quantity: entry.attendee.quantity,
});

/** Build one SVG ticket standing in for a hidden package: the package name and
 * the bundle's summed quantity/price, on the shared check-in token, so the
 * attachment never reveals the member listings (mirrors {@link
 * collapsedPackageEntry} in the email body). */
const collapsedSvgTicketData = (
  entries: EmailEntry[],
  currency: string,
  packageName: string,
): SvgTicketData => ({
  attendeeDate: null,
  checkinUrl: buildCheckinUrl(entries[0]!.attendee.ticket_token),
  currency,
  listingDate: "",
  listingLocation: "",
  listingName: packageName,
  pricePaid: String(sumEntryPrices(entries)),
  purchaseOnly: entries.every((e) => e.listing.purchase_only),
  quantity: sumEntryQuantities(entries),
});

/** Generate SVG ticket attachments for all entries. A HIDDEN package collapses
 * to a single package-level SVG so the buyer's attachments don't reveal the
 * member listings the email body hides. */
export const buildTicketAttachments = async (
  entries: EmailEntry[],
  currency: string,
  hiddenPackage?: PackageDisplay | null,
): Promise<EmailAttachment[]> => {
  const ticketDataList = hiddenPackage
    ? [collapsedSvgTicketData(entries, currency, hiddenPackage.name)]
    : map((entry: EmailEntry) => buildSvgTicketData(entry, currency))(entries);
  const svgs = await Promise.all(
    ticketDataList.map((data) => generateSvgTicket(data)),
  );
  return svgs.map((svg, i) => ({
    content: toBase64(new TextEncoder().encode(svg)),
    contentType: "image/svg+xml",
    filename:
      ticketDataList.length === 1 ? "ticket.svg" : `ticket-${i + 1}.svg`,
  }));
};

/**
 * Send registration confirmation + admin notification emails.
 * Entries is an array because one registration can cover multiple listings.
 * Silently skips if email is not configured.
 * Attaches one SVG ticket per entry to the confirmation email.
 */
export const sendRegistrationEmails = async (
  entries: EmailEntry[],
  currency: string,
): Promise<void> => {
  const config = (await getEmailConfig()) ?? getHostEmailConfig();
  if (!config) return;

  const attendeeRaw = entries[0]?.attendee.email;
  const attendeeEmail = attendeeRaw ? parseEmail(attendeeRaw) : null;
  const businessEmail = parseEmail(settings.businessEmail);
  const ticketUrl = buildTicketUrl(entries);
  const promises: Promise<number | undefined>[] = [];

  if (attendeeEmail) {
    const replyTo = businessEmail || undefined;
    // The buyer's confirmation hides a hidden package's member listings — both
    // in the email body and in the attached ticket SVGs.
    const pkg = await getPackageDisplayForEntries(entries);
    const hiddenPackage = pkg?.hideListings === true ? pkg : null;
    const data = await buildTemplateData(entries, currency, ticketUrl, {
      hidePackageMembers: true,
    });
    const [confirmation, attachments] = await Promise.all([
      renderEmailContent("confirmation", data),
      buildTicketAttachments(entries, currency, hiddenPackage),
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
    // The admin notification always shows package members, even when hidden.
    const data = await buildTemplateData(entries, currency, ticketUrl);
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
// request reaches many recipients. Sending one request per recipient would blow
// the edge runtime's per-invocation sub-request budget, so providers without a
// batch API are unsupported for bulk (the admin UI falls back to a mailto:
// link). The only per-recipient variation is the unsubscribe link, so a bulk
// send is a shared subject/html/text template (with BULK_UNSUBSCRIBE_PLACEHOLDER
// where each recipient's link goes) plus the recipient list. Array-batch
// providers (Resend, Postmark) substitute the link per message; Mailgun uses its
// recipient-variables. New batch providers slot into the registry below.
// ---------------------------------------------------------------------------

/** Placeholder in a bulk template marking where each recipient's unsubscribe URL goes. */
export const BULK_UNSUBSCRIBE_PLACEHOLDER = "%%bulk_unsubscribe_url%%";

/** One bulk recipient: address plus its unsubscribe URL (marketing sends only). */
export type BulkRecipient = { to: ValidEmail; unsubscribeUrl?: string };

/** A bulk send: shared template (html/text may contain the placeholder) + recipients. */
export type BulkEmailPayload = {
  subject: string;
  html: string;
  text: string;
  recipients: BulkRecipient[];
};

type BulkTemplate = Pick<BulkEmailPayload, "subject" | "html" | "text">;

/** Substitute the unsubscribe placeholder (absent for transactional templates). */
const fillUnsubscribe = (template: string, value: string): string =>
  template.replaceAll(BULK_UNSUBSCRIBE_PLACEHOLDER, value);

/** Builds the HTTP request for one batch of recipients. */
type BulkBatchBuilder = (
  config: EmailConfig,
  template: BulkTemplate,
  batch: BulkRecipient[],
) => [url: string, headers: Headers, body: unknown];

type BulkProviderSpec = {
  /** Maximum recipients the provider accepts in a single batch request. */
  maxBatchSize: number;
  build: BulkBatchBuilder;
};

/** Mailgun batch send: one message to many recipients, personalized via
 * recipient-variables (required, else every address leaks into the To header). */
const mailgunBulk =
  (host: string): BulkBatchBuilder =>
  (config, template, batch) => {
    const form = new FormData();
    form.append("from", config.fromAddress);
    for (const r of batch) form.append("to", r.to);
    form.append("subject", template.subject);
    form.append("html", fillUnsubscribe(template.html, "%recipient.unsub%"));
    form.append("text", fillUnsubscribe(template.text, "%recipient.unsub%"));
    form.append(
      "recipient-variables",
      JSON.stringify(
        Object.fromEntries(
          batch.map((r) => [
            r.to,
            r.unsubscribeUrl ? { unsub: r.unsubscribeUrl } : {},
          ]),
        ),
      ),
    );
    return [
      `https://${host}/v3/${emailHost(config.fromAddress)}/messages`,
      { Authorization: `Basic ${btoa(`api:${config.apiKey}`)}` },
      form,
    ];
  };

const BULK_PROVIDERS = {
  "mailgun-eu": {
    build: mailgunBulk("api.eu.mailgun.net"),
    maxBatchSize: 1000,
  },
  "mailgun-us": { build: mailgunBulk("api.mailgun.net"), maxBatchSize: 1000 },
  postmark: {
    build: (config, template, batch) => [
      "https://api.postmarkapp.com/email/batch",
      { Accept: "application/json", "X-Postmark-Server-Token": config.apiKey },
      batch.map((r) => ({
        From: config.fromAddress,
        HtmlBody: fillUnsubscribe(template.html, r.unsubscribeUrl ?? ""),
        Subject: template.subject,
        TextBody: fillUnsubscribe(template.text, r.unsubscribeUrl ?? ""),
        To: r.to,
      })),
    ],
    maxBatchSize: 500,
  },
  resend: {
    build: (config, template, batch) => [
      "https://api.resend.com/emails/batch",
      bearerAuth(config.apiKey),
      batch.map((r) => ({
        from: config.fromAddress,
        html: fillUnsubscribe(template.html, r.unsubscribeUrl ?? ""),
        subject: template.subject,
        text: fillUnsubscribe(template.text, r.unsubscribeUrl ?? ""),
        to: [r.to],
      })),
    ],
    maxBatchSize: 100,
  },
  // SendGrid batches via one request with up to 1000 personalizations; each
  // recipient's unsubscribe URL is a legacy substitution into shared content.
  sendgrid: {
    build: (config, template, batch) => [
      "https://api.sendgrid.com/v3/mail/send",
      bearerAuth(config.apiKey),
      {
        content: [
          {
            type: "text/plain",
            value: fillUnsubscribe(template.text, "-unsub-"),
          },
          {
            type: "text/html",
            value: fillUnsubscribe(template.html, "-unsub-"),
          },
        ],
        from: { email: config.fromAddress },
        personalizations: batch.map((r) => ({
          to: [{ email: r.to }],
          ...(r.unsubscribeUrl
            ? { substitutions: { "-unsub-": r.unsubscribeUrl } }
            : {}),
        })),
        subject: template.subject,
      },
    ],
    maxBatchSize: 1000,
  },
} as const satisfies Record<EmailProvider, BulkProviderSpec>;

/** What the provider returned for one batch: HTTP status, ok flag, and the raw
 * response body. Providers reply with queued message IDs (or rejection
 * reasons), so the body is kept to surface back to the sender and the log. */
export type BulkBatchResponse = {
  status: number;
  ok: boolean;
  body: string;
};

/** Outcome of a bulk send: recipients attempted, batches sent, recipients in
 * failed batches, and the raw per-batch provider responses. */
export type BulkSendResult = {
  attempted: number;
  batches: number;
  failed: number;
  responses: BulkBatchResponse[];
};

/**
 * Send a bulk email via the configured provider. Every supported provider has a
 * batch endpoint, so this works for any `EmailConfig`. Chunks recipients to the
 * provider's batch limit and POSTs each chunk; logs (never throws) on a non-OK
 * batch, whose recipients then count as failed. Each batch's provider response
 * is captured so the caller can relay it to the sender.
 */
export const sendBulkEmails = async (
  config: EmailConfig,
  payload: BulkEmailPayload,
): Promise<BulkSendResult> => {
  const spec = BULK_PROVIDERS[config.provider];
  const { recipients, ...template } = payload;
  const batches = chunk(spec.maxBatchSize)(recipients);
  const responses: BulkBatchResponse[] = [];
  let failed = 0;
  for (const batch of batches) {
    const { ok, status, text } = await sendRequest(
      spec.build(config, template, batch),
    );
    responses.push({ body: text, ok, status });
    if (!ok) {
      failed += batch.length;
      logError({
        code: ErrorCode.EMAIL_SEND,
        detail: `bulk status=${status} provider=${config.provider} count=${batch.length}`,
      });
    }
  }
  return {
    attempted: recipients.length,
    batches: batches.length,
    failed,
    responses,
  };
};

/** Send a test email to the business email address. Returns HTTP status or undefined on non-HTTP errors. */
export const sendTestEmail = async (
  config: EmailConfig,
  to: ValidEmail,
): Promise<number | undefined> => {
  return await sendEmail(config, {
    html: `<p>${t("fields.email.test_body")}</p>`,
    subject: t("fields.email.test_subject"),
    text: t("fields.email.test_body"),
    to,
  });
};
