/**
 * Bulk-email targets — the registry of "who gets this email".
 *
 * Every way of choosing recipients (a named audience, a single listing, a
 * single attendee) is one self-contained `TargetSpec` in `REGISTRY`. The
 * generic operations exported below — parse from a request, serialise back to
 * a query string, validate, resolve recipients, describe — are thin folds over
 * that registry (`specOf(target).operation(…)`), so adding a new way to pick
 * recipients means adding one spec: none of the dispatchers, routes or
 * templates change.
 */

import * as v from "valibot";
import { filter, firstMatch, map } from "#fp";
import {
  getAllAttendeePiiBlobs,
  getAttendeePiiBlobForToken,
  getAttendeePiiBlobsForListings,
} from "#shared/db/attendees/queries.ts";
import { getAllListings, getListingWithCount } from "#shared/db/listings.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ListingWithCount } from "#shared/types.ts";

// ── Audiences ───────────────────────────────────────────────────────

/** Named recipient groups selectable from the Emails page. */
export const AUDIENCE_IDS = ["active", "upcoming", "all"] as const;
export const AudienceIdSchema = v.picklist(AUDIENCE_IDS);
export type AudienceId = v.InferOutput<typeof AudienceIdSchema>;
export const isAudienceId = (s: string): s is AudienceId =>
  v.is(AudienceIdSchema, s);

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
// guard (`isBulkEmailTarget`) is a variant composed from all three.

/** A named audience, chosen from the Emails page. */
const audienceTargetSchema = v.object({
  audience: AudienceIdSchema,
  kind: v.literal("audience"),
});
/** One listing, from that listing's admin page. */
const listingTargetSchema = v.object({
  kind: v.literal("listing"),
  listingId: v.pipe(v.number(), v.integer()),
});
/** One attendee, from that attendee's edit page (by non-empty ticket token). */
const attendeeTargetSchema = v.object({
  kind: v.literal("attendee"),
  token: v.pipe(v.string(), v.nonEmpty()),
});

export type AudienceTarget = v.InferOutput<typeof audienceTargetSchema>;
export type ListingTarget = v.InferOutput<typeof listingTargetSchema>;
export type AttendeeTarget = v.InferOutput<typeof attendeeTargetSchema>;

/** What a bulk email is aimed at. */
export type BulkEmailTarget = AudienceTarget | ListingTarget | AttendeeTarget;

/** Runtime schema for a target — a variant over the per-kind schemas above.
 * Drives {@link isBulkEmailTarget} and is exported so later validation tiers
 * can compose it (e.g. into a draft schema). */
export const BulkEmailTargetSchema = v.variant("kind", [
  audienceTargetSchema,
  listingTargetSchema,
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

// ── Spec interface ──────────────────────────────────────────────────

/**
 * The outcome of parsing one target's params from a request:
 *   - `undefined` — not this target's params; try the next spec
 *   - `null` — this target's params, but invalid/gone (the caller 404s)
 *   - a target — parsed and (where cheap) validated
 */
type ParseOutcome<T> = T | null | undefined;
type Parsed<T> = ParseOutcome<T> | Promise<ParseOutcome<T>>;

/** Everything one target kind needs, in one place. */
type TargetSpec<T extends BulkEmailTarget> = {
  /** Parse from compose-page query params. */
  readonly fromQuery: (params: URLSearchParams) => Parsed<T>;
  /** Parse from posted form fields. */
  readonly fromForm: (form: FormParams) => Parsed<T>;
  /** Serialise back to a `?…` compose-page query string. */
  readonly toQuery: (target: T) => string;
  /** How the compose form shows/edits this target. */
  readonly composeControl: (target: T) => ComposeControl;
  /** Heading + intro for the compose page. */
  readonly composeCopy: ComposeCopy;
  /** Encrypted PII blobs for this target's recipients. */
  readonly loadPiiBlobs: (target: T, now: number) => Promise<string[]>;
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

// ── Audience recipients ─────────────────────────────────────────────

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

/** Build an audience target from a raw value, defaulting unknown/blank input. */
const audienceTargetFrom = (raw: string | null): AudienceTarget => ({
  audience: raw && isAudienceId(raw) ? raw : DEFAULT_AUDIENCE_ID,
  kind: "audience",
});

/** Compose copy shared by the bulk (audience / listing) targets. */
const BULK_COMPOSE_COPY: ComposeCopy = {
  heading: "Send a bulk email",
  intro:
    "Email your attendees about an upcoming listing or other news. Choose who receives it, write your message in Markdown, then preview before sending.",
};

const audienceSpec: TargetSpec<AudienceTarget> = {
  allowEmpty: true,
  composeControl: (target) => ({
    label: "Audience",
    mode: "select",
    name: "audience",
    options: AUDIENCES.map((a) => ({ label: a.label, value: a.id })),
    selected: target.audience,
  }),
  composeCopy: BULK_COMPOSE_COPY,
  describe: (target) => {
    const audience = audienceById(target.audience);
    return {
      audienceDescription: audience.description,
      targetLabel: audience.label,
    };
  },
  fromForm: (form) => audienceTargetFrom(form.getString("audience")),
  fromQuery: (params) => audienceTargetFrom(params.get("audience")),
  loadPiiBlobs: async (target, now) =>
    target.audience === "all"
      ? getAllAttendeePiiBlobs()
      : getAttendeePiiBlobsForListings(
          await audienceListingIds(target.audience, now),
        ),
  logListingId: () => null,
  singleRecipient: false,
  toQuery: (target) => `?audience=${target.audience}`,
};

// ── Listing recipients ──────────────────────────────────────────────

/** Resolve a listing id string to a target, or null if invalid/gone. */
const listingTargetFromRaw = async (
  raw: string,
): Promise<ListingTarget | null> => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const listing = await getListingWithCount(id);
  return listing ? { kind: "listing", listingId: id } : null;
};

const listingSpec: TargetSpec<ListingTarget> = {
  allowEmpty: false,
  composeControl: (target) => ({
    fields: [["listing_id", String(target.listingId)]],
    mode: "fixed",
  }),
  composeCopy: BULK_COMPOSE_COPY,
  describe: async (target) => {
    const listing = await getListingWithCount(target.listingId);
    return {
      targetLabel: listing
        ? `Attendees of ${listing.name}`
        : "Listing attendees",
    };
  },
  fromForm: (form) => {
    const raw = form.getString("listing_id");
    return raw ? listingTargetFromRaw(raw) : undefined;
  },
  fromQuery: (params) => {
    const raw = params.get("listing");
    return raw ? listingTargetFromRaw(raw) : undefined;
  },
  loadPiiBlobs: (target) => getAttendeePiiBlobsForListings([target.listingId]),
  logListingId: (target) => target.listingId,
  singleRecipient: false,
  toQuery: (target) => `?listing=${target.listingId}`,
};

// ── Attendee recipient ──────────────────────────────────────────────

const attendeeSpec: TargetSpec<AttendeeTarget> = {
  allowEmpty: false,
  composeControl: (target) => ({
    fields: [["attendee", target.token]],
    mode: "fixed",
  }),
  composeCopy: {
    heading: "Email an attendee",
    intro:
      "Send a one-off email to this attendee. Write your message in Markdown, then preview before sending.",
  },
  describe: (_target, recipients) => ({
    targetLabel: recipients[0] ?? "the selected attendee",
  }),
  fromForm: (form) => {
    const token = form.getString("attendee");
    return token ? { kind: "attendee", token } : undefined;
  },
  fromQuery: (params) => {
    const token = params.get("attendee");
    return token ? { kind: "attendee", token } : undefined;
  },
  loadPiiBlobs: async (target) => {
    const blob = await getAttendeePiiBlobForToken(target.token);
    return blob ? [blob] : [];
  },
  logListingId: () => null,
  singleRecipient: true,
  toQuery: (target) => `?attendee=${encodeURIComponent(target.token)}`,
};

// ── Registry + dispatchers ──────────────────────────────────────────

const REGISTRY = {
  attendee: attendeeSpec,
  audience: audienceSpec,
  listing: listingSpec,
} as const;

/** The spec for a target's kind. The cast is the one contained cost of a
 * heterogeneous registry: at runtime the lookup always returns the spec whose
 * `T` matches `target`. */
const specOf = <T extends BulkEmailTarget>(target: T): TargetSpec<T> =>
  REGISTRY[target.kind] as unknown as TargetSpec<T>;

/** Serialise a target back to a `?…` compose-page query string. */
export const targetQuery = (target: BulkEmailTarget): string =>
  specOf(target).toQuery(target);

/** How the compose form should show/edit this target (selector or fixed). */
export const targetComposeControl = (target: BulkEmailTarget): ComposeControl =>
  specOf(target).composeControl(target);

/** Heading + intro for composing to this kind of target. */
export const targetComposeCopy = (target: BulkEmailTarget): ComposeCopy =>
  specOf(target).composeCopy;

/** Encrypted PII blobs for whichever attendees a target covers. */
export const loadTargetPiiBlobs = (
  target: BulkEmailTarget,
  now: number,
): Promise<string[]> => specOf(target).loadPiiBlobs(target, now);

/** Human label (+ optional description) for a target, given its recipients. */
export const describeTarget = (
  target: BulkEmailTarget,
  recipients: readonly string[],
): TargetDescription | Promise<TargetDescription> =>
  specOf(target).describe(target, recipients);

/** Whether an empty recipient set is acceptable for a target (vs. a 404). */
export const targetAllowsEmpty = (target: BulkEmailTarget): boolean =>
  specOf(target).allowEmpty;

/** Whether a target always resolves to a single person (tunes page wording). */
export const targetIsSingleRecipient = (target: BulkEmailTarget): boolean =>
  specOf(target).singleRecipient;

/** Listing id to attribute a send to in the activity log, or null. */
export const targetLogListingId = (target: BulkEmailTarget): number | null =>
  specOf(target).logListingId(target);

// Parsers in match-precedence order: specific targets first, the audience
// (which always yields a default) as the catch-all. Each parser widens to
// `Parsed<BulkEmailTarget>` so the ordered fold is a single firstMatch.
const QUERY_PARSERS: ReadonlyArray<
  (params: URLSearchParams) => Parsed<BulkEmailTarget>
> = [attendeeSpec.fromQuery, listingSpec.fromQuery, audienceSpec.fromQuery];

const FORM_PARSERS: ReadonlyArray<
  (form: FormParams) => Parsed<BulkEmailTarget>
> = [attendeeSpec.fromForm, listingSpec.fromForm, audienceSpec.fromForm];

/** Run an ordered set of parsers over a source, returning the first claimed
 * target (or null if the only claim was an invalid one — `firstMatch` treats
 * `null` as a match, `undefined` as "try the next"). */
const firstTarget = async <S>(
  parsers: ReadonlyArray<(source: S) => Parsed<BulkEmailTarget>>,
  source: S,
): Promise<BulkEmailTarget | null> =>
  (await firstMatch(parsers.map((parse) => () => parse(source)))) ?? null;

/** Resolve a compose-page target from query params, or null if it's gone. */
export const targetFromQuery = (
  params: URLSearchParams,
): Promise<BulkEmailTarget | null> => firstTarget(QUERY_PARSERS, params);

/** Resolve a target from posted form fields, or null if a named target is gone. */
export const targetFromForm = (
  form: FormParams,
): Promise<BulkEmailTarget | null> => firstTarget(FORM_PARSERS, form);
