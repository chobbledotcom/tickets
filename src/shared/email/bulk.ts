import { chunk } from "#fp";
import {
  bearerAuth,
  type EmailConfig,
  type EmailRequest,
  mailgunForm,
  sendEmailRequest,
} from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { emailHost, type ValidEmail } from "#shared/validation/email.ts";

export const BULK_UNSUBSCRIBE_PLACEHOLDER = "%%bulk_unsubscribe_url%%";

export type BulkRecipient = { to: ValidEmail; unsubscribeUrl?: string };

export interface BulkEmailPayload {
  html: string;
  recipients: BulkRecipient[];
  subject: string;
  text: string;
}

type BulkTemplate = Pick<BulkEmailPayload, "subject" | "html" | "text">;

const fillUnsubscribe = (template: string, value: string): string =>
  template.replaceAll(BULK_UNSUBSCRIBE_PLACEHOLDER, value);

type BulkBatchBuilder = (
  config: EmailConfig,
  template: BulkTemplate,
  batch: BulkRecipient[],
) => EmailRequest;

interface BulkProviderSpec {
  build: BulkBatchBuilder;
  maxBatchSize: number;
}

const mailgunBulk =
  (host: string): BulkBatchBuilder =>
  (config, template, batch) => {
    const form = mailgunForm(config);
    for (const recipient of batch) form.append("to", recipient.to);
    form.append("subject", template.subject);
    form.append("html", fillUnsubscribe(template.html, "%recipient.unsub%"));
    form.append("text", fillUnsubscribe(template.text, "%recipient.unsub%"));
    form.append(
      "recipient-variables",
      JSON.stringify(
        Object.fromEntries(
          batch.map((recipient) => [
            recipient.to,
            recipient.unsubscribeUrl ? { unsub: recipient.unsubscribeUrl } : {},
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
      batch.map((recipient) => ({
        From: config.fromAddress,
        HtmlBody: fillUnsubscribe(
          template.html,
          recipient.unsubscribeUrl ?? "",
        ),
        Subject: template.subject,
        TextBody: fillUnsubscribe(
          template.text,
          recipient.unsubscribeUrl ?? "",
        ),
        To: recipient.to,
      })),
    ],
    maxBatchSize: 500,
  },
  resend: {
    build: (config, template, batch) => [
      "https://api.resend.com/emails/batch",
      bearerAuth(config.apiKey),
      batch.map((recipient) => ({
        from: config.fromAddress,
        html: fillUnsubscribe(template.html, recipient.unsubscribeUrl ?? ""),
        subject: template.subject,
        text: fillUnsubscribe(template.text, recipient.unsubscribeUrl ?? ""),
        to: [recipient.to],
      })),
    ],
    maxBatchSize: 100,
  },
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
        personalizations: batch.map((recipient) => ({
          to: [{ email: recipient.to }],
          ...(recipient.unsubscribeUrl
            ? { substitutions: { "-unsub-": recipient.unsubscribeUrl } }
            : {}),
        })),
        subject: template.subject,
      },
    ],
    maxBatchSize: 1000,
  },
} as const satisfies Record<EmailConfig["provider"], BulkProviderSpec>;

export interface BulkBatchResponse {
  body: string;
  ok: boolean;
  status: number;
}

export interface BulkSendResult {
  attempted: number;
  batches: number;
  failed: number;
  responses: BulkBatchResponse[];
}

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
    const { ok, status, text } = await sendEmailRequest(
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
