/**
 * Bulk email domain logic — audiences, recipient resolution, drafts and the
 * marketing unsubscribe footer.
 *
 * Sending itself lives in `#shared/email.ts` (`sendBulkEmails`); this module
 * decides *who* gets a message and *what* the message looks like. The audience
 * model is deliberately a small, strictly-typed registry so new audiences can
 * be added in one place without touching the routes or templates.
 */

import { compact, filter, map, pipe, sort, unique, uniqueBy } from "#fp";
import { getEffectiveDomain } from "#shared/config.ts";
import { decryptPiiBlob } from "#shared/db/attendees/pii.ts";
import {
  getAllAttendeePiiBlobs,
  getAttendeePiiBlobForToken,
  getAttendeePiiBlobsForListings,
} from "#shared/db/attendees/queries.ts";
import { hashEmail } from "#shared/db/email-preferences.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  BULK_UNSUBSCRIBE_PLACEHOLDER,
  type BulkBatchResponse,
  type BulkEmailPayload,
  type BulkRecipient,
} from "#shared/email.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import {
  createTypeGuard,
  isRecord,
  type ListingWithCount,
} from "#shared/types.ts";
import { parseEmail } from "#shared/validation/email.ts";

// ── Audiences ───────────────────────────────────────────────────────

/** Named recipient groups selectable from the Emails page. */
export const AUDIENCE_IDS = ["active", "upcoming", "all"] as const;
export type AudienceId = (typeof AUDIENCE_IDS)[number];
export const isAudienceId = createTypeGuard(AUDIENCE_IDS);

export type Audience = {
  readonly id: AudienceId;
  readonly label: string;
  /** One-line explanation shown in the selector and on the preview page. */
  readonly description: string;
};

/** Registry of audiences, in the order they appear in the dropdown. */
export const AUDIENCES: readonly Audience[] = [
  {
    description: "Everyone booked onto a listing that is currently active.",
    id: "active",
    label: "Active listing attendees",
  },
  {
    description:
      "Everyone booked onto an active listing that has not happened yet.",
    id: "upcoming",
    label: "Upcoming listing attendees",
  },
  {
    description: "Everyone who has ever registered, across every listing.",
    id: "all",
    label: "All attendees",
  },
];

/** The audience pre-selected when none is specified. */
export const DEFAULT_AUDIENCE_ID: AudienceId = "active";

/** Look up an audience definition by id (ids come from AUDIENCES, always present). */
export const audienceById = (id: AudienceId): Audience =>
  AUDIENCES.find((a) => a.id === id)!;

// ── Targets ─────────────────────────────────────────────────────────

/**
 * What a bulk email is aimed at: a named audience (from the Emails page), a
 * single listing (from that listing's admin page), or a single attendee
 * identified by ticket token (from that attendee's edit page).
 */
export type BulkEmailTarget =
  | { readonly kind: "audience"; readonly audience: AudienceId }
  | { readonly kind: "listing"; readonly listingId: number }
  | { readonly kind: "attendee"; readonly token: string };

/** Query string that round-trips a target back to the compose page. */
export const targetQuery = (target: BulkEmailTarget): string => {
  if (target.kind === "listing") return `?listing=${target.listingId}`;
  if (target.kind === "attendee") {
    return `?attendee=${encodeURIComponent(target.token)}`;
  }
  return `?audience=${target.audience}`;
};

/** Runtime guard for a deserialized target (drafts are stored as JSON). */
export const isBulkEmailTarget = (v: unknown): v is BulkEmailTarget => {
  if (!isRecord(v)) return false;
  if (v.kind === "audience") {
    return typeof v.audience === "string" && isAudienceId(v.audience);
  }
  if (v.kind === "listing") {
    return typeof v.listingId === "number" && Number.isInteger(v.listingId);
  }
  if (v.kind === "attendee") {
    return typeof v.token === "string" && v.token !== "";
  }
  return false;
};

// ── Recipient resolution ────────────────────────────────────────────

/** Whether an active listing has not yet happened (no date = ongoing/undated). */
const isUpcomingListing = (listing: ListingWithCount, now: number): boolean => {
  if (!listing.active) return false;
  if (listing.date === "") return true;
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  return listing.date >= todayStart.toISOString();
};

/** Listing IDs covered by an "active" or "upcoming" audience. */
const audienceListingIds = async (
  audience: Exclude<AudienceId, "all">,
  now: number,
): Promise<number[]> => {
  const listings = await getAllListings();
  const matches =
    audience === "active"
      ? filter((l: ListingWithCount) => l.active)
      : filter((l: ListingWithCount) => isUpcomingListing(l, now));
  return map((l: ListingWithCount) => l.id)(matches(listings));
};

/** Load the encrypted PII blobs for whichever attendees a target covers. */
const loadTargetPiiBlobs = async (
  target: BulkEmailTarget,
  now: number,
): Promise<string[]> => {
  if (target.kind === "listing") {
    return getAttendeePiiBlobsForListings([target.listingId]);
  }
  if (target.kind === "attendee") {
    const blob = await getAttendeePiiBlobForToken(target.token);
    return blob ? [blob] : [];
  }
  if (target.audience === "all") {
    return getAllAttendeePiiBlobs();
  }
  return getAttendeePiiBlobsForListings(
    await audienceListingIds(target.audience, now),
  );
};

/** Trim, drop blanks, de-duplicate case-insensitively, and sort a list of emails. */
export const dedupeEmails = (emails: string[]): string[] =>
  pipe(
    map((e: string) => e.trim()),
    filter((e: string) => e !== ""),
    uniqueBy((e: string) => e.toLowerCase()),
    sort((a: string, b: string) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    ),
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

const isBulkEmailDraft = (v: unknown): v is BulkEmailDraft =>
  isRecord(v) &&
  typeof v.subject === "string" &&
  typeof v.body === "string" &&
  typeof v.marketing === "boolean" &&
  isBulkEmailTarget(v.target);

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
  const validRecipients = compact(params.recipients.map(parseEmail));
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
  const total = counts.reduce((sum, n) => sum + n, 0);
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
 * Build a `mailto:` link that BCCs every recipient with the subject and body
 * prefilled. Addresses go in BCC so recipients can't see each other. Used as a
 * fallback for admins without a configured (bulk-capable) email provider, and
 * offered alongside provider sending in all cases.
 */
export const buildMailtoLink = (
  emails: string[],
  subject: string,
  body: string,
): string => {
  const parts: string[] = [];
  if (emails.length > 0) {
    parts.push(`bcc=${emails.map((e) => encodeURIComponent(e)).join(",")}`);
  }
  if (subject) parts.push(`subject=${encodeURIComponent(subject)}`);
  if (body) {
    // Normalise CRLF/CR to LF first so every line break encodes to a single
    // %0A rather than %0D%0A, which some mail clients render as a stray ^M.
    const normalizedBody = body.replace(/\r\n?/g, "\n");
    parts.push(`body=${encodeURIComponent(normalizedBody)}`);
  }
  return `mailto:?${parts.join("&")}`;
};
