/**
 * Bulk email domain logic — recipient resolution, drafts and the marketing
 * unsubscribe footer.
 *
 * *Who* a message goes to (the audience/listing/attendee target registry)
 * lives in `#shared/bulk-email-targets.ts`; the target API is re-exported here
 * so callers have a single import. Sending itself lives in `#shared/email.ts`
 * (`sendBulkEmails`). This module turns a target into a de-duplicated address
 * list, validates drafts, and builds the send payload + unsubscribe footer.
 */

import {
  filter,
  map,
  mapNotNullish,
  pipe,
  sort,
  sum,
  unique,
  uniqueBy,
} from "#fp";
import {
  type BulkEmailTarget,
  isBulkEmailTarget,
  loadTargetPiiBlobs,
} from "#shared/bulk-email-targets.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { decryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { hashEmail } from "#shared/db/contact-preferences.ts";
import {
  BULK_UNSUBSCRIBE_PLACEHOLDER,
  type BulkBatchResponse,
  type BulkEmailPayload,
  type BulkRecipient,
} from "#shared/email.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { isRecord } from "#shared/types.ts";
import { parseEmail } from "#shared/validation/email.ts";

// Re-export the target registry's public API so `#shared/bulk-email.ts` stays
// the single entry point for callers (routes, templates, tests).
export {
  AUDIENCES,
  type Audience,
  type AudienceId,
  AudienceIdSchema,
  audienceById,
  type BulkEmailTarget,
  BulkEmailTargetSchema,
  type ComposeControl,
  type ComposeCopy,
  DEFAULT_AUDIENCE_ID,
  describeTarget,
  isAudienceId,
  isBulkEmailTarget,
  type TargetDescription,
  targetAllowsEmpty,
  targetComposeControl,
  targetComposeCopy,
  targetFromForm,
  targetFromQuery,
  targetIsSingleRecipient,
  targetLogListingId,
  targetQuery,
} from "#shared/bulk-email-targets.ts";

// ── Recipient resolution ────────────────────────────────────────────

/** Trim, drop blanks, de-duplicate case-insensitively, and sort a list of emails. */
export const dedupeEmails = (emails: string[]): string[] =>
  pipe(
    map((e: string) => e.trim()),
    filter((e) => e !== ""),
    uniqueBy((e) => e.toLowerCase()),
    sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
  )(emails);

/**
 * Resolve the de-duplicated recipient email list for a target. Requires the
 * admin private key to decrypt attendee PII. `now` is injectable for tests.
 */
export const resolveRecipientEmails = async (
  target: BulkEmailTarget,
  privateKey: CryptoKey,
  now: number = nowMs(),
): Promise<string[]> => {
  const blobs = await loadTargetPiiBlobs(target, now);
  const decrypted = await Promise.all(
    blobs.map((blob) => decryptPiiBlob(blob, privateKey, false)),
  );
  return dedupeEmails(map((d: { email: string }) => d.email)(decrypted));
};

// ── Drafts ──────────────────────────────────────────────────────────

export const MAX_BULK_EMAIL_SUBJECT_LENGTH = 255;

/** A composed-but-not-yet-sent bulk email, persisted between compose → preview → send. */
export type BulkEmailDraft = {
  readonly subject: string;
  readonly body: string;
  readonly marketing: boolean;
  readonly target: BulkEmailTarget;
};

const isBulkEmailDraft = (val: unknown): val is BulkEmailDraft =>
  isRecord(val) &&
  typeof val.subject === "string" &&
  typeof val.body === "string" &&
  typeof val.marketing === "boolean" &&
  isBulkEmailTarget(val.target);

/** Serialize a draft for storage in settings. */
export const serializeDraft = (draft: BulkEmailDraft): string =>
  JSON.stringify(draft);

/** Parse a stored draft, returning null for missing or malformed values. */
export const parseDraft = (raw: string): BulkEmailDraft | null => {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isBulkEmailDraft(parsed) ? parsed : null;
};

export type DraftValidation =
  | { valid: true; draft: BulkEmailDraft }
  | { valid: false; error: string };

/** Validate composed form values into a draft (subject + body required, length-capped). */
export const validateDraftInput = (input: {
  subject: string;
  body: string;
  marketing: boolean;
  target: BulkEmailTarget;
}): DraftValidation => {
  const subject = input.subject.trim();
  if (!subject) return { error: "Subject is required", valid: false };
  if (subject.length > MAX_BULK_EMAIL_SUBJECT_LENGTH) {
    return {
      error: `Subject must be ${MAX_BULK_EMAIL_SUBJECT_LENGTH} characters or fewer`,
      valid: false,
    };
  }

  const body = input.body.trim();
  if (!body) return { error: "Message body is required", valid: false };
  if (body.length > MAX_TEXTAREA_LENGTH) {
    return {
      error: `Message body must be ${MAX_TEXTAREA_LENGTH} characters or fewer`,
      valid: false,
    };
  }

  return {
    draft: { body, marketing: input.marketing, subject, target: input.target },
    valid: true,
  };
};

// ── Marketing footer + unsubscribe links ────────────────────────────

/** Absolute unsubscribe URL carrying the recipient's opaque email hash. */
export const unsubscribeUrl = (hash: string): string =>
  `https://${getEffectiveDomain()}/unsubscribe?email=${encodeURIComponent(
    hash,
  )}`;

const FOOTER_INTRO =
  "You're receiving this because you registered for one of our listings.";

/** HTML unsubscribe footer appended to marketing emails. */
export const marketingFooterHtml = (url: string): string =>
  `<hr><p style="font-size:12px;color:#666">${FOOTER_INTRO} ` +
  `<a href="${url}">Unsubscribe or manage your preferences</a>.</p>`;

/** Plain-text unsubscribe footer appended to marketing emails. */
export const marketingFooterText = (url: string): string =>
  `\n\n---\n${FOOTER_INTRO}\nUnsubscribe or manage your preferences: ${url}`;

/**
 * Build a bulk send payload from a recipient list.
 *
 * For marketing sends, unsubscribed addresses are dropped and each remaining
 * recipient gets an unsubscribe URL (carrying that address's hash); the shared
 * template's footer holds BULK_UNSUBSCRIBE_PLACEHOLDER, which the email layer
 * fills in per recipient. Transactional sends go to everyone with no footer.
 */
export const buildBulkPayload = async (params: {
  subject: string;
  recipients: string[];
  bodyHtml: string;
  bodyText: string;
  marketing: boolean;
  unsubscribed: Set<string>;
}): Promise<BulkEmailPayload> => {
  // Recipients come from validated, stored addresses; parse them through the
  // canonical validator so each carries the ValidEmail type the send API
  // requires, dropping any that somehow fail rather than sending blind.
  const validRecipients = mapNotNullish(parseEmail)(params.recipients);
  if (!params.marketing) {
    return {
      html: params.bodyHtml,
      recipients: validRecipients.map((to) => ({ to })),
      subject: params.subject,
      text: params.bodyText,
    };
  }
  const recipients: BulkRecipient[] = [];
  for (const to of validRecipients) {
    const hash = await hashEmail(to);
    if (params.unsubscribed.has(hash)) continue;
    recipients.push({ to, unsubscribeUrl: unsubscribeUrl(hash) });
  }
  return {
    html: params.bodyHtml + marketingFooterHtml(BULK_UNSUBSCRIBE_PLACEHOLDER),
    recipients,
    subject: params.subject,
    text: params.bodyText + marketingFooterText(BULK_UNSUBSCRIBE_PLACEHOLDER),
  };
};

// ── Contact-frequency insight ───────────────────────────────────────

/**
 * One-line summary of how often a set of recipients has been contacted, from
 * their per-email contact counts. Empty when there are no recipients.
 */
export const contactFrequencySummary = (counts: number[]): string => {
  if (counts.length === 0) return "";
  const total = sum(counts);
  if (total === 0) {
    return "These attendees have never been contacted through this page.";
  }
  const average = total / counts.length;
  return Number.isInteger(average)
    ? `These attendees have been contacted through this page ${average} times each.`
    : `These attendees have been contacted through this page an average of ${average.toFixed(
        1,
      )} times each.`;
};

// ── Provider reply ──────────────────────────────────────────────────

/** Cap on how much of a provider's reply we echo back, so a verbose body can't
 * blow a flash cookie or flood the activity log. */
const MAX_PROVIDER_REPLY_LENGTH = 300;

/**
 * One-line, human-readable summary of what the email provider said in reply to
 * a bulk send. Providers acknowledge a batch with queued message IDs or, on
 * failure, a reason — both worth surfacing to the sender and storing in the
 * log. Distinct per-batch replies are de-duplicated and the result is
 * length-capped.
 */
export const summarizeProviderResponse = (
  responses: readonly BulkBatchResponse[],
): string => {
  if (responses.length === 0) return "The email provider sent no response.";
  const parts = pipe(
    map((r: BulkBatchResponse) => {
      const body = r.body.trim();
      return body ? `HTTP ${r.status}: ${body}` : `HTTP ${r.status}`;
    }),
    unique,
  )(responses as BulkBatchResponse[]);
  const joined = parts.join("; ");
  const trimmed =
    joined.length > MAX_PROVIDER_REPLY_LENGTH
      ? `${joined.slice(0, MAX_PROVIDER_REPLY_LENGTH)}...`
      : joined;
  return `The email provider responded with ${trimmed}.`;
};

// ── mailto fallback ─────────────────────────────────────────────────

/**
 * Build a `mailto:` link with the subject and body prefilled.
 *
 * A lone recipient is addressed directly in the `To:` field — there's no one
 * to hide them from, so no BCC. Multiple recipients go in BCC so they can't
 * see each other, and the draft is addressed to the owner's own
 * `businessEmail` (when set) so the `To:` field isn't left empty. Used as a
 * fallback for admins without a configured (bulk-capable) email provider, and
 * offered alongside provider sending in all cases.
 */
export const buildMailtoLink = (
  emails: string[],
  subject: string,
  body: string,
  businessEmail = "",
): string => {
  const parts: string[] = [];
  let to = "";
  if (emails.length === 1) {
    to = emails[0]!;
  } else if (emails.length > 1) {
    to = businessEmail;
    parts.push(`bcc=${emails.map((e) => encodeURIComponent(e)).join(",")}`);
  }
  if (subject) parts.push(`subject=${encodeURIComponent(subject)}`);
  if (body) {
    // Normalise CRLF/CR to LF first so every line break encodes to a single
    // %0A rather than %0D%0A, which some mail clients render as a stray ^M.
    const normalizedBody = body.replace(/\r\n?/g, "\n");
    parts.push(`body=${encodeURIComponent(normalizedBody)}`);
  }
  return `mailto:${encodeURIComponent(to)}?${parts.join("&")}`;
};
