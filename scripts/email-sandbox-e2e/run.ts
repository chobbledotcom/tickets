/**
 * Run one provider's leg: a single send and a bulk send through the
 * production delivery code, against the provider's real API. The probes
 * carry the shapes that differ per provider — an attachment, a reply-to
 * address, and the bulk unsubscribe substitution — so drift in any mapping
 * surfaces as a refused request.
 */

import { toBase64 } from "#crypto/utils.ts";
import { randomId } from "#e2e/config.ts";
import {
  BULK_UNSUBSCRIBE_PLACEHOLDER,
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

const isAccepted = (status: number | undefined): boolean =>
  status !== undefined && status >= 200 && status < 300;

/** A response body flattened to one short Markdown-table-safe line. */
const oneLine = (text: string): string =>
  text
    .replaceAll(/[|\s]+/g, " ")
    .trim()
    .slice(0, 160);

const runReadyLeg = async (
  config: EmailConfig,
  to: ValidEmail,
): Promise<EmailLegOutcome> => {
  const runId = randomId();
  const singleStatus = await sendEmail(config, probeMessage(config, to, runId));
  const bulk = await sendBulkEmails(
    config,
    bulkProbePayload(config.provider, to, runId),
  );
  // One recipient means one batch, so zero failed means it was accepted.
  const sent = isAccepted(singleStatus) && bulk.failed === 0;
  const statuses = bulk.responses.map((response) => response.status).join(", ");
  const refusalBodies = bulk.responses
    .filter((response) => !response.ok)
    .map((response) => oneLine(response.body));
  const detail = [
    // sendEmail reports a thrown send as undefined — show it as "no response".
    `single ${singleStatus ?? "no response"}, bulk ${statuses}`,
    ...refusalBodies,
  ].join(" — ");
  return {
    detail,
    provider: config.provider,
    state: sent ? "sent" : "failed",
  };
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
  try {
    return await runReadyLeg(plan.config, plan.to);
  } catch (error) {
    // One leg's crash must not stop the later legs from running and reporting.
    return { detail: errorMessage(error), provider, state: "failed" };
  }
};
