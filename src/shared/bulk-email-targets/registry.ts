/**
 * Bulk-email targets — the registry of "who gets this email".
 *
 * Every way of choosing recipients (a named audience, a listing, one of its
 * days, a single attendee) is one self-contained `TargetSpec`, declared in its
 * own module and gathered into `REGISTRY` here. The generic operations exported
 * below — parse from a request, serialise back to a query string, resolve
 * recipients, describe — are thin folds over that registry
 * (`specOf(target).operation(…)`), so adding a new way to pick recipients means
 * adding one spec: none of the dispatchers, routes or templates change.
 */

import { firstMatch } from "#fp";
import { attendeeSpec } from "./attendee.ts";
import { audienceSpec } from "./audience.ts";
import { listingDaySpec, listingSpec } from "./listings.ts";
import type {
  BulkEmailTarget,
  ComposeControl,
  ComposeCopy,
  Parsed,
  TargetDescription,
  TargetForm,
  TargetPiiBlobs,
  TargetSpec,
} from "./types.ts";

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
): TargetPiiBlobs => specOf(target).loadPiiBlobs(target, now);

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
  (form: TargetForm) => Parsed<BulkEmailTarget>
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
  form: TargetForm,
): Promise<BulkEmailTarget | null> => firstTarget(FORM_PARSERS, form);
