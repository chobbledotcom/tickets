/**
 * Run one provider's leg: a single send and a bulk send through the
 * production delivery code, against the provider's real API. The probes
 * carry the shapes that differ per provider — an attachment, a reply-to
 * address, and the bulk unsubscribe substitution — so drift in any mapping
 * surfaces as a refused request.
 */

import * as v from "valibot";
import { toBase64 } from "#crypto/utils.ts";
import { randomId } from "#e2e/config.ts";
import {
  BULK_UNSUBSCRIBE_PLACEHOLDER,
  type BulkBatchResponse,
  type BulkEmailPayload,
  sendBulkEmails,
} from "#shared/email/bulk.ts";
import {
  type EmailConfig,
  type EmailMessage,
  type EmailProvider,
  sendEmail,
} from "#shared/email.ts";
import { errorMessage } from "#shared/error-message.ts";
import type { ValidEmail } from "#shared/validation/email.ts";
import { resolveEmailLeg } from "./legs.ts";

/** What one leg reports back, with a one-line fact for the summary table. */
export interface EmailLegOutcome {
  detail: string;
  provider: EmailProvider;
  state: "sent" | "skipped" | "failed";
}

/** A tiny valid SVG, so every provider's attachment mapping is exercised. */
const PROBE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#111"/></svg>';

/** The address the bulk unsubscribe substitution writes into the message. */
const PROBE_UNSUBSCRIBE_URL = "https://example.com/unsubscribe";

/** One leg's allowance for its two live requests. A provider that accepts
 * the connection and then stalls becomes a failed leg, not a killed job. */
const LEG_TIMEOUT_MS = 120_000;

const probeMessage = (
  config: EmailConfig,
  to: ValidEmail,
  runId: string,
): EmailMessage => ({
  attachments: [
    {
      content: toBase64(new TextEncoder().encode(PROBE_SVG)),
      contentType: "image/svg+xml",
      filename: "probe.svg",
    },
  ],
  html: `<p>Single-send probe ${runId} for ${config.provider}.</p>`,
  replyTo: config.fromAddress,
  subject: `Email sandbox e2e ${runId} (${config.provider}, single)`,
  text: `Single-send probe ${runId} for ${config.provider}.`,
  to,
});

const bulkProbePayload = (
  provider: EmailProvider,
  to: ValidEmail,
  runId: string,
): BulkEmailPayload => ({
  html: `<p>Bulk probe ${runId} for ${provider}. <a href="${BULK_UNSUBSCRIBE_PLACEHOLDER}">Unsubscribe</a></p>`,
  recipients: [{ to, unsubscribeUrl: PROBE_UNSUBSCRIBE_URL }],
  subject: `Email sandbox e2e ${runId} (${provider}, bulk)`,
  text: `Bulk probe ${runId} for ${provider}. Unsubscribe: ${BULK_UNSUBSCRIBE_PLACEHOLDER}`,
});

/** A response body flattened to one short Markdown-table-safe line. */
const oneLine = (text: string): string =>
  text
    .replaceAll(/[|\s]+/g, " ")
    .trim()
    .slice(0, 160);

const PostmarkBatchSchema = v.array(
  v.looseObject({ ErrorCode: v.number(), Message: v.string() }),
);

/** Postmark can accept a batch with HTTP 200 and still refuse a message
 * inside it (a nonzero per-message ErrorCode, for example a suppressed
 * recipient), so read each accepted reply's per-message results. */
const postmarkReplyProblems = (responses: BulkBatchResponse[]): string[] =>
  responses.flatMap((response) => {
    if (!response.ok) return [];
    const results = v.safeParse(PostmarkBatchSchema, JSON.parse(response.body));
    if (!results.success) {
      return ["Postmark batch reply carries no per-message results"];
    }
    return results.output
      .filter((result) => result.ErrorCode !== 0)
      .map((result) =>
        oneLine(`Postmark ErrorCode ${result.ErrorCode}: ${result.Message}`),
      );
  });

type BulkReplyCheck = (responses: BulkBatchResponse[]) => string[];

/** For most providers the HTTP status is the whole verdict. */
const acceptedByStatus: BulkReplyCheck = () => [];

/** Providers whose accepted bulk reply needs a second read. */
const BULK_REPLY_CHECKS: Record<EmailProvider, BulkReplyCheck> = {
  "mailgun-eu": acceptedByStatus,
  "mailgun-us": acceptedByStatus,
  postmark: postmarkReplyProblems,
  resend: acceptedByStatus,
  sendgrid: acceptedByStatus,
};

const runReadyLeg = async (
  config: EmailConfig,
  to: ValidEmail,
): Promise<EmailLegOutcome> => {
  const runId = randomId();
  const single = await sendEmail(config, probeMessage(config, to, runId));
  const bulk = await sendBulkEmails(
    config,
    bulkProbePayload(config.provider, to, runId),
  );
  const replyProblems = BULK_REPLY_CHECKS[config.provider](bulk.responses);
  const sent =
    single.delivered && bulk.failed === 0 && replyProblems.length === 0;
  const refusals = [
    // sendEmail already parses, redacts, and caps the single reply's reason.
    ...(single.delivered ? [] : [oneLine(single.reason)]),
    ...bulk.responses
      .filter((response) => !response.ok)
      .map((response) => oneLine(response.body)),
    // A refusal can come with an empty body; the status already says it.
  ].filter((text) => text !== "");
  // A thrown single send has no status; sendEmail reports it as undefined.
  const statuses = `single ${single.status ?? "no response"}, bulk ${bulk.responses
    .map((response) => response.status)
    .join(", ")}`;
  return {
    detail: [statuses, ...refusals, ...replyProblems].join(" — "),
    provider: config.provider,
    state: sent ? "sent" : "failed",
  };
};

const legTimeout = (): { cancel: () => void; expired: Promise<never> } => {
  const timer = { id: 0 };
  const expired = new Promise<never>((_, reject) => {
    timer.id = setTimeout(
      () => reject(new Error(`leg timed out after ${LEG_TIMEOUT_MS / 1000}s`)),
      LEG_TIMEOUT_MS,
    );
  });
  return { cancel: () => clearTimeout(timer.id), expired };
};

/** Resolve and run one provider's leg, and say what happened. */
export const runEmailLeg = async (
  provider: EmailProvider,
): Promise<EmailLegOutcome> => {
  const plan = resolveEmailLeg(provider);
  if (plan.state === "skipped") {
    return { detail: plan.reason, provider, state: "skipped" };
  }
  if (plan.state === "broken") {
    return { detail: plan.reason, provider, state: "failed" };
  }
  const timeout = legTimeout();
  try {
    // finally() cancels the timer on both settlements, so a finished leg
    // leaves no pending timeout behind.
    return await Promise.race([
      runReadyLeg(plan.config, plan.to),
      timeout.expired,
    ]).finally(timeout.cancel);
  } catch (error) {
    // One leg's crash must not stop the later legs from running and reporting.
    return { detail: errorMessage(error), provider, state: "failed" };
  }
};
