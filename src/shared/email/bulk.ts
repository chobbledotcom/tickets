import * as v from "valibot";
import { chunk } from "#fp";
import {
  bearerAuth,
  type EmailConfig,
  type EmailRequest,
  failureReason,
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

/** What an accepted batch reply says about the messages inside it. */
export interface PerMessageRefusals {
  /** How many of the batch's recipients the provider refused. */
  count: number;
  /** One reason per refused message, redacted for the operator. */
  reasons: string[];
}

/** Reads an accepted reply for messages the provider refused anyway. */
type AcceptedReplyReader = (
  body: string,
  batchSize: number,
) => PerMessageRefusals;

interface BulkProviderSpec {
  build: BulkBatchBuilder;
  maxBatchSize: number;
  readAcceptedReply: AcceptedReplyReader;
}

const NOTHING_REFUSED: PerMessageRefusals = { count: 0, reasons: [] };

/** Most providers take or refuse a whole batch, so the status says it all. */
const acceptedMeansSent: AcceptedReplyReader = () => NOTHING_REFUSED;

/** Postmark answers a batch with one result per message. `ErrorCode` is 0
 * on the messages it took. */
const PostmarkResultsSchema = v.array(
  v.looseObject({ ErrorCode: v.number(), Message: v.string() }),
);

/** The reply as JSON, or null when it is not JSON. A body we cannot parse
 * is a body we cannot read, which the caller counts as unconfirmed. */
const replyJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

/** Postmark can answer 200 and still refuse a message inside the batch, for
 * example a suppressed recipient. Postmark answers for every message it
 * took, so a reply we cannot read, or one that skips a message, leaves the
 * whole batch unconfirmed. That counts as refused, not as sent. */
const readPostmarkReply: AcceptedReplyReader = (body, batchSize) => {
  const results = v.safeParse(PostmarkResultsSchema, replyJson(body));
  if (!results.success || results.output.length !== batchSize) {
    return {
      count: batchSize,
      reasons: [
        "Postmark accepted the batch but its reply did not answer for every message",
      ],
    };
  }
  const refused = results.output.filter((result) => result.ErrorCode !== 0);
  return {
    count: refused.length,
    reasons: refused.map((result) =>
      failureReason(`Postmark error ${result.ErrorCode}: ${result.Message}`),
    ),
  };
};

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
    readAcceptedReply: acceptedMeansSent,
  },
  "mailgun-us": {
    build: mailgunBulk("api.mailgun.net"),
    maxBatchSize: 1000,
    readAcceptedReply: acceptedMeansSent,
  },
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
    readAcceptedReply: readPostmarkReply,
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
    readAcceptedReply: acceptedMeansSent,
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
    readAcceptedReply: acceptedMeansSent,
  },
} as const satisfies Record<EmailConfig["provider"], BulkProviderSpec>;

export interface BulkBatchResponse {
  body: string;
  ok: boolean;
  /** Messages this batch's own reply refused, even when it was accepted. */
  refusals: PerMessageRefusals;
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
  signal: AbortSignal | null = null,
): Promise<BulkSendResult> => {
  const spec = BULK_PROVIDERS[config.provider];
  const { recipients, ...template } = payload;
  const batches = chunk(spec.maxBatchSize)(recipients);
  const responses: BulkBatchResponse[] = [];
  let failed = 0;
  for (const batch of batches) {
    const { ok, status, text } = await sendEmailRequest(
      spec.build(config, template, batch),
      signal,
    );
    // A refused request loses the whole batch; an accepted one can still
    // refuse messages inside it.
    const refusals = ok
      ? spec.readAcceptedReply(text, batch.length)
      : { count: batch.length, reasons: [] };
    responses.push({ body: text, ok, refusals, status });
    failed += refusals.count;
    if (refusals.count > 0) {
      logError({
        code: ErrorCode.EMAIL_SEND,
        detail: `bulk status=${status} provider=${config.provider} count=${refusals.count}`,
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
