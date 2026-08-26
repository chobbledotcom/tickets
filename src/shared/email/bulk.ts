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

/** What one batch's reply said about the messages inside it. */
export interface BatchMessageOutcome {
  /** One reason per refused message, redacted for the operator. */
  reasons: string[];
  /** How many of the batch's messages the provider refused outright. */
  refused: number;
  /** How many messages the reply did not account for. The provider took the
   * batch, so these may or may not have been sent. They are neither sent nor
   * refused, and saying otherwise invites a duplicate send. */
  unconfirmed: number;
}

/** What a reply says, before it is counted. */
interface AcceptedBatch {
  /** One reason per refused message, when the reply gave one. */
  reasons: string[];
  /** Places in the batch whose message the provider refused. */
  refused: number[];
  unconfirmed: number;
}

/** A request the provider refused loses every message in the batch. Its
 * status is the whole reason, so it names none per message. */
const wholeBatchRefused = (size: number): AcceptedBatch => ({
  reasons: [],
  refused: Array.from({ length: size }, (_, index) => index),
  unconfirmed: 0,
});

/** Reads an accepted reply for what it says about each message. */
type AcceptedReplyReader = (body: string, batchSize: number) => AcceptedBatch;

interface BulkProviderSpec {
  build: BulkBatchBuilder;
  maxBatchSize: number;
  readAcceptedReply: AcceptedReplyReader;
}

const TOOK_EVERY_MESSAGE: AcceptedBatch = {
  reasons: [],
  refused: [],
  unconfirmed: 0,
};

/** Most providers take or refuse a whole batch, so the status says it all. */
const acceptedMeansSent: AcceptedReplyReader = () => TOOK_EVERY_MESSAGE;

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
 * example a suppressed recipient, so read every result. Postmark took the
 * batch, so a reply we cannot read leaves those messages unconfirmed rather
 * than refused: they may be queued, and calling them refused would invite a
 * second send to people who already have the mail. */
const readPostmarkReply: AcceptedReplyReader = (body, batchSize) => {
  const results = v.safeParse(PostmarkResultsSchema, replyJson(body));
  if (!results.success || results.output.length !== batchSize) {
    return { reasons: [], refused: [], unconfirmed: batchSize };
  }
  const refused: number[] = [];
  const reasons: string[] = [];
  for (const [index, result] of results.output.entries()) {
    if (result.ErrorCode === 0) continue;
    refused.push(index);
    reasons.push(
      failureReason(`Postmark error ${result.ErrorCode}: ${result.Message}`),
    );
  }
  return { reasons, refused, unconfirmed: 0 };
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
  /** What this batch's reply said about its own messages. */
  outcome: BatchMessageOutcome;
  status: number;
}

export interface BulkSendResult {
  attempted: number;
  batches: number;
  /** Recipients the provider refused. */
  failed: number;
  responses: BulkBatchResponse[];
  /** Recipients the provider took, for the contact history. A message the
   * reply left unconfirmed is here, because the provider accepted it. */
  taken: ValidEmail[];
  /** Messages an accepted reply did not account for. */
  unconfirmed: number;
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
  const taken: ValidEmail[] = [];
  let failed = 0;
  let unconfirmed = 0;
  for (const batch of batches) {
    const { ok, status, text } = await sendEmailRequest(
      spec.build(config, template, batch),
      signal,
    );
    // A refused request loses the whole batch. An accepted one can still
    // refuse, or fail to account for, messages inside it.
    const accepted = ok
      ? spec.readAcceptedReply(text, batch.length)
      : wholeBatchRefused(batch.length);
    const refusedPlaces = new Set(accepted.refused);
    for (const [index, recipient] of batch.entries()) {
      if (!refusedPlaces.has(index)) taken.push(recipient.to);
    }
    const outcome: BatchMessageOutcome = {
      reasons: accepted.reasons,
      refused: accepted.refused.length,
      unconfirmed: accepted.unconfirmed,
    };
    responses.push({ body: text, ok, outcome, status });
    failed += outcome.refused;
    unconfirmed += outcome.unconfirmed;
    if (outcome.refused > 0) {
      logError({
        code: ErrorCode.EMAIL_SEND,
        detail: `bulk status=${status} provider=${config.provider} count=${outcome.refused}`,
      });
    }
  }
  return {
    attempted: recipients.length,
    batches: batches.length,
    failed,
    responses,
    taken,
    unconfirmed,
  };
};
