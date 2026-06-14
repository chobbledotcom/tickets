/**
 * Bulk email domain logic — audiences, recipient resolution, drafts and the
 * marketing unsubscribe footer.
 *
 * Sending itself lives in `#shared/email.ts` (`sendBulkEmails`); this module
 * decides *who* gets a message and *what* the message looks like. The audience
 * model is deliberately a small, strictly-typed registry so new audiences can
 * be added in one place without touching the routes or templates.
 */

import { filter, map, pipe, sort, uniqueBy } from "#fp";
import { getEffectiveDomain } from "#shared/config.ts";
import { decryptPiiBlob } from "#shared/db/attendees/pii.ts";
import {
  getAllAttendeePiiBlobs,
  getAttendeePiiBlobsForEvents,
} from "#shared/db/attendees/queries.ts";
import { getAllEvents } from "#shared/db/events.ts";
import { hashEmail } from "#shared/db/unsubscribes.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import {
  createTypeGuard,
  type EventWithCount,
  isRecord,
} from "#shared/types.ts";

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
    description: "Everyone booked onto an event that is currently active.",
    id: "active",
    label: "Active event attendees",
  },
  {
    description:
      "Everyone booked onto an active event that has not happened yet.",
    id: "upcoming",
    label: "Upcoming event attendees",
  },
  {
    description: "Everyone who has ever registered, across every event.",
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
 * What a bulk email is aimed at: either a named audience (from the Emails
 * page) or a single event (from that event's admin page).
 */
export type BulkEmailTarget =
  | { readonly kind: "audience"; readonly audience: AudienceId }
  | { readonly kind: "event"; readonly eventId: number };

/** Query string that round-trips a target back to the compose page. */
export const targetQuery = (target: BulkEmailTarget): string =>
  target.kind === "event"
    ? `?event=${target.eventId}`
    : `?audience=${target.audience}`;

/** Runtime guard for a deserialized target (drafts are stored as JSON). */
export const isBulkEmailTarget = (v: unknown): v is BulkEmailTarget => {
  if (!isRecord(v)) return false;
  if (v.kind === "audience") {
    return typeof v.audience === "string" && isAudienceId(v.audience);
  }
  if (v.kind === "event") {
    return typeof v.eventId === "number" && Number.isInteger(v.eventId);
  }
  return false;
};

// ── Recipient resolution ────────────────────────────────────────────

/** Whether an active event has not yet happened (no date = ongoing/undated). */
const isUpcomingEvent = (event: EventWithCount, now: number): boolean => {
  if (!event.active) return false;
  if (event.date === "") return true;
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  return event.date >= todayStart.toISOString();
};

/** Event IDs covered by an "active" or "upcoming" audience. */
const audienceEventIds = async (
  audience: Exclude<AudienceId, "all">,
  now: number,
): Promise<number[]> => {
  const events = await getAllEvents();
  const matches =
    audience === "active"
      ? filter((e: EventWithCount) => e.active)
      : filter((e: EventWithCount) => isUpcomingEvent(e, now));
  return map((e: EventWithCount) => e.id)(matches(events));
};

/** Load the encrypted PII blobs for whichever attendees a target covers. */
const loadTargetPiiBlobs = async (
  target: BulkEmailTarget,
  now: number,
): Promise<string[]> => {
  if (target.kind === "event") {
    return getAttendeePiiBlobsForEvents([target.eventId]);
  }
  if (target.audience === "all") {
    return getAllAttendeePiiBlobs();
  }
  return getAttendeePiiBlobsForEvents(
    await audienceEventIds(target.audience, now),
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
  "You're receiving this because you registered for one of our events.";

/** HTML unsubscribe footer appended to marketing emails. */
export const marketingFooterHtml = (url: string): string =>
  `<hr><p style="font-size:12px;color:#666">${FOOTER_INTRO} ` +
  `<a href="${url}">Unsubscribe or manage your preferences</a>.</p>`;

/** Plain-text unsubscribe footer appended to marketing emails. */
export const marketingFooterText = (url: string): string =>
  `\n\n---\n${FOOTER_INTRO}\nUnsubscribe or manage your preferences: ${url}`;

/** A single ready-to-send message (recipient + final, per-recipient bodies). */
export type BulkRecipientMessage = { to: string; html: string; text: string };

/**
 * Turn a recipient list into ready-to-send messages.
 *
 * For marketing sends, unsubscribed addresses are dropped and a per-recipient
 * unsubscribe footer (carrying that address's hash) is appended. Transactional
 * sends go to everyone with no footer.
 */
export const buildBulkMessages = async (params: {
  recipients: string[];
  bodyHtml: string;
  bodyText: string;
  marketing: boolean;
  unsubscribed: Set<string>;
}): Promise<BulkRecipientMessage[]> => {
  const messages: BulkRecipientMessage[] = [];
  for (const to of params.recipients) {
    if (!params.marketing) {
      messages.push({ html: params.bodyHtml, text: params.bodyText, to });
      continue;
    }
    const hash = await hashEmail(to);
    if (params.unsubscribed.has(hash)) continue;
    const url = unsubscribeUrl(hash);
    messages.push({
      html: params.bodyHtml + marketingFooterHtml(url),
      text: params.bodyText + marketingFooterText(url),
      to,
    });
  }
  return messages;
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
  if (body) parts.push(`body=${encodeURIComponent(body)}`);
  return `mailto:?${parts.join("&")}`;
};
