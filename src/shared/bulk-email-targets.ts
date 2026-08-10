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
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { formatDateLabel } from "#shared/dates.ts";
import {
  getAllAttendeePiiBlobs,
  getAttendeePiiBlobForToken,
  getAttendeePiiBlobsForListingDay,
  getAttendeePiiBlobsForListings,
} from "#shared/db/attendees/queries.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import {
  getAllListings,
  getListingWithCount,
} from "#shared/db/listings/records.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { IsoDateSchema, isIsoDate } from "#shared/validation/date.ts";
import { guardFor } from "#shared/validation/guard.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

// ── Audiences ───────────────────────────────────────────────────────

/** Named recipient groups selectable from the Emails page. */
export const AUDIENCE_IDS = ["active", "upcoming", "all"] as const;
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
// guard (`isBulkEmailTarget`) is a variant composed from all three.

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
  readonly loadPiiBlobs: (
    target: T,
    now: number,
  ) => Promise<OwnerKeyEncrypted[]>;
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
const fixedControl = (name: string, value: string): ComposeControl => ({
  fields: [[name, value]],
  mode: "fixed",
});

/** Turn a field's raw value into a target when it has one, else `undefined`
 * ("not this target's field — try the next spec"). The form and query parsers
 * both read one field, so they share this "present → build" step. */
const fromRawField =
  <T extends BulkEmailTarget>(fromRaw: (raw: string) => Parsed<T>) =>
  (raw: string | null | undefined): Parsed<T> =>
    raw ? fromRaw(raw) : undefined;

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
  const id = parsePositiveIntId(raw);
  if (id === null) return null;
  const listing = await getListingWithCount(id);
  return listing ? { kind: "listing", listingId: id } : null;
};

/** How a listing-scoped target names itself: the listing's own name while it is
 * still there, and a plain fallback once it is gone. `narrowing` says which
 * part of it the target means, so one day reads as the listing plus its day. */
const describeListingAttendees = async (
  listingId: number,
  narrowing = "",
): Promise<TargetDescription> => {
  const listing = await getListingWithCount(listingId);
  return {
    targetLabel: listing
      ? `Attendees of ${listing.name}${narrowing}`
      : `Listing attendees${narrowing}`,
  };
};

/** What the two listing-scoped targets answer the same way: the listing a send
 * is logged against, that they always mean a group rather than one person, and
 * the query string both are reached by. */
const listingScoped = {
  logListingId: (target: { listingId: number }): number => target.listingId,
  singleRecipient: false,
} as const;

/** The query a listing-scoped target is reached by. One day adds its own day to
 * this rather than spelling the listing part out again. */
const listingQuery = (listingId: number): string => `?listing=${listingId}`;

const listingSpec: TargetSpec<ListingTarget> = {
  ...listingScoped,
  allowEmpty: false,
  composeControl: (target) =>
    fixedControl("listing_id", String(target.listingId)),
  composeCopy: BULK_COMPOSE_COPY,
  describe: (target) => describeListingAttendees(target.listingId),
  fromForm: (form) =>
    fromRawField(listingTargetFromRaw)(form.getString("listing_id")),
  fromQuery: (params) =>
    fromRawField(listingTargetFromRaw)(params.get("listing")),
  loadPiiBlobs: (target) => getAttendeePiiBlobsForListings([target.listingId]),
  toQuery: (target) => listingQuery(target.listingId),
};

// ── One day of a listing's recipients ───────────────────────────────

/** Resolve a listing id and a day to a target, or null if either is no good.
 * Both parts have to be there: a listing without a day is the whole-listing
 * target, which is a different (and still offered) way to choose. */
const listingDayTargetFrom = async (
  rawListing: string | null | undefined,
  rawDay: string | null | undefined,
): Promise<ListingDayTarget | null | undefined> => {
  if (!rawListing || !rawDay) return;
  const id = parsePositiveIntId(rawListing);
  if (id === null || !isIsoDate(rawDay)) return null;
  const listing = await getListingWithCount(id);
  return listing ? { day: rawDay, kind: "listing-day", listingId: id } : null;
};

const listingDaySpec: TargetSpec<ListingDayTarget> = {
  ...listingScoped,
  allowEmpty: false,
  composeControl: (target) => ({
    fields: [
      ["listing_id", String(target.listingId)],
      ["day", target.day],
    ],
    mode: "fixed",
  }),
  composeCopy: BULK_COMPOSE_COPY,
  describe: (target) =>
    describeListingAttendees(
      target.listingId,
      ` on ${formatDateLabel(target.day)}`,
    ),
  fromForm: (form) =>
    listingDayTargetFrom(form.getString("listing_id"), form.getString("day")),
  fromQuery: (params) =>
    listingDayTargetFrom(params.get("listing"), params.get("day")),
  loadPiiBlobs: (target) =>
    getAttendeePiiBlobsForListingDay(target.listingId, dateToRange(target.day)),
  toQuery: (target) => `${listingQuery(target.listingId)}&day=${target.day}`,
};

// ── Attendee recipient ──────────────────────────────────────────────

/** Build an attendee target from a (non-empty) ticket token. */
const attendeeTargetFromRaw = (token: string): AttendeeTarget => ({
  kind: "attendee",
  token,
});

const attendeeSpec: TargetSpec<AttendeeTarget> = {
  allowEmpty: false,
  composeControl: (target) => fixedControl("attendee", target.token),
  composeCopy: {
    heading: "Email an attendee",
    intro:
      "Send a one-off email to this attendee. Write your message in Markdown, then preview before sending.",
  },
  describe: (_target, recipients) => ({
    targetLabel: recipients[0] ?? "the selected attendee",
  }),
  fromForm: (form) =>
    fromRawField(attendeeTargetFromRaw)(form.getString("attendee")),
  fromQuery: (params) =>
    fromRawField(attendeeTargetFromRaw)(params.get("attendee")),
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
  "listing-day": listingDaySpec,
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
): Promise<OwnerKeyEncrypted[]> => specOf(target).loadPiiBlobs(target, now);

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
> = [
  attendeeSpec.fromQuery,
  listingDaySpec.fromQuery,
  listingSpec.fromQuery,
  audienceSpec.fromQuery,
];

const FORM_PARSERS: ReadonlyArray<
  (form: FormParams) => Parsed<BulkEmailTarget>
> = [
  attendeeSpec.fromForm,
  listingDaySpec.fromForm,
  listingSpec.fromForm,
  audienceSpec.fromForm,
];

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
