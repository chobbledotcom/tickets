/**
 * What a bulk email can be aimed at: the audience catalogue, the per-kind
 * target schemas, and the `TargetSpec` interface every kind implements.
 *
 * Types and data only — each kind's behaviour lives in its own module
 * (`audience.ts`, `listings.ts`, `attendee.ts`) and they are gathered into one
 * registry by `registry.ts`.
 */

import * as v from "valibot";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import type { FormParams } from "#shared/form-data.ts";
import { IsoDateSchema } from "#shared/validation/date.ts";
import { guardFor } from "#shared/validation/guard.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

// ── Audiences ───────────────────────────────────────────────────────

/** Named recipient groups selectable from the Emails page. */
const AUDIENCE_IDS = ["active", "upcoming", "all"] as const;
export const AudienceIdSchema = v.picklist(AUDIENCE_IDS);
export type AudienceId = v.InferOutput<typeof AudienceIdSchema>;
export const isAudienceId = guardFor(AudienceIdSchema);

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

// ── Target type ─────────────────────────────────────────────────────

// Per-kind valibot schemas — each target kind's single source of truth for its
// shape. The individual `*Target` types are inferred from them, and the union
// guard (`isBulkEmailTarget`) is a variant composed from all of them.

/** A named audience, chosen from the Emails page. */
const audienceTargetSchema = v.object({
  audience: AudienceIdSchema,
  kind: v.literal("audience"),
});
/** The listing a listing-scoped target names. Declared once so the whole
 * listing and one of its days cannot drift apart on what a listing id is. */
const listingIdField = v.pipe(v.number(), v.integer());
/** One listing, from that listing's admin page. */
const listingTargetSchema = v.object({
  kind: v.literal("listing"),
  listingId: listingIdField,
});
/** One day of one listing booked by the day, from that day's attendee list. */
const listingDayTargetSchema = v.object({
  day: IsoDateSchema,
  kind: v.literal("listing-day"),
  listingId: listingIdField,
});
/** One attendee, from that attendee's edit page (by non-empty ticket token). */
const attendeeTargetSchema = v.object({
  kind: v.literal("attendee"),
  token: NonEmptyTextSchema,
});

export type AudienceTarget = v.InferOutput<typeof audienceTargetSchema>;
export type ListingTarget = v.InferOutput<typeof listingTargetSchema>;
export type ListingDayTarget = v.InferOutput<typeof listingDayTargetSchema>;
export type AttendeeTarget = v.InferOutput<typeof attendeeTargetSchema>;

/** What a bulk email is aimed at. */
export type BulkEmailTarget =
  | AudienceTarget
  | ListingTarget
  | ListingDayTarget
  | AttendeeTarget;

/** Runtime schema for a target — a variant over the per-kind schemas above.
 * Drives {@link isBulkEmailTarget} and is exported so later validation tiers
 * can compose it (e.g. into a draft schema). */
export const BulkEmailTargetSchema = v.variant("kind", [
  audienceTargetSchema,
  listingTargetSchema,
  listingDayTargetSchema,
  attendeeTargetSchema,
]);

/** Runtime guard for a deserialised target (drafts are stored as JSON). */
export const isBulkEmailTarget = (val: unknown): val is BulkEmailTarget =>
  v.is(BulkEmailTargetSchema, val);

/** Human label (+ optional description) for the compose/preview pages. */
export type TargetDescription = {
  /** e.g. "Active listing attendees", "Attendees of Gig", "alice@example.com". */
  readonly targetLabel: string;
  /** Extra one-line explanation (audiences only). */
  readonly audienceDescription?: string;
};

/**
 * How the compose form lets the owner see/adjust a target. The view renders
 * this generically — a `select` chooser (you can change the value) or a `fixed`
 * target (hidden inputs that round-trip a pre-chosen value, shown as a label).
 * A new target kind just declares one of these; the template never branches on
 * the kind.
 */
export type ComposeControl =
  | {
      readonly mode: "select";
      readonly label: string;
      readonly name: string;
      readonly selected: string;
      readonly options: readonly {
        readonly value: string;
        readonly label: string;
      }[];
    }
  | {
      readonly mode: "fixed";
      readonly fields: ReadonlyArray<readonly [name: string, value: string]>;
    };

/** Static heading + intro shown when composing to a kind of target. */
export type ComposeCopy = { readonly heading: string; readonly intro: string };

/** Compose copy shared by the bulk (audience / listing) targets. */
export const BULK_COMPOSE_COPY: ComposeCopy = {
  heading: "Send a bulk email",
  intro:
    "Email your attendees about an upcoming listing or other news. Choose who receives it, write your message in Markdown, then preview before sending.",
};

// ── Spec interface ──────────────────────────────────────────────────

/**
 * The outcome of parsing one target's params from a request:
 *   - `undefined` — not this target's params; try the next spec
 *   - `null` — this target's params, but invalid/gone (the caller 404s)
 *   - a target — parsed and (where cheap) validated
 */
export type ParseOutcome<T> = T | null | undefined;
export type Parsed<T> = ParseOutcome<T> | Promise<ParseOutcome<T>>;

/** The posted fields a target is parsed from. */
export type TargetForm = FormParams;
/** A target's recipients, still encrypted — what `loadPiiBlobs` yields. */
export type TargetPiiBlobs = Promise<OwnerKeyEncrypted[]>;

/** Everything one target kind needs, in one place. */
export type TargetSpec<T extends BulkEmailTarget> = {
  /** Parse from compose-page query params. */
  readonly fromQuery: (params: URLSearchParams) => Parsed<T>;
  /** Parse from posted form fields. */
  readonly fromForm: (form: TargetForm) => Parsed<T>;
  /** Serialise back to a `?…` compose-page query string. */
  readonly toQuery: (target: T) => string;
  /** How the compose form shows/edits this target. */
  readonly composeControl: (target: T) => ComposeControl;
  /** Heading + intro for the compose page. */
  readonly composeCopy: ComposeCopy;
  /** Encrypted PII blobs for this target's recipients. */
  readonly loadPiiBlobs: (target: T, now: number) => TargetPiiBlobs;
  /** Human label (+ optional description) for the compose/preview pages. */
  readonly describe: (
    target: T,
    recipients: readonly string[],
  ) => TargetDescription | Promise<TargetDescription>;
  /** Whether an empty recipient set is acceptable (true) or a 404 (false). */
  readonly allowEmpty: boolean;
  /** Whether this target always resolves to a single person (tunes wording). */
  readonly singleRecipient: boolean;
  /** Listing id to attribute a send to in the activity log, or null. */
  readonly logListingId: (target: T) => number | null;
};

/** A hidden fixed control that round-trips one pre-chosen field value — the
 * compose control for every target picked through a single form field. */
export const fixedControl = (name: string, value: string): ComposeControl => ({
  fields: [[name, value]],
  mode: "fixed",
});

/** Turn a field's raw value into a target when it has one, else `undefined`
 * ("not this target's field — try the next spec"). The form and query parsers
 * both read one field, so they share this "present → build" step. */
export const fromRawField =
  <T extends BulkEmailTarget>(fromRaw: (raw: string) => Parsed<T>) =>
  (raw: string | null | undefined): Parsed<T> =>
    raw ? fromRaw(raw) : undefined;
