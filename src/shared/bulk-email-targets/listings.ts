/** The two listing-scoped targets: a whole listing, and one day of a listing
 * booked by the day. They share how they name themselves, what they log
 * against, and the query string they are reached by. */

import { formatDateLabel } from "#shared/dates.ts";
import {
  getAttendeePiiBlobsForListingDay,
  getAttendeePiiBlobsForListings,
} from "#shared/db/attendees/queries.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";
import {
  BULK_COMPOSE_COPY,
  fixedControl,
  fromRawField,
  type ListingDayTarget,
  type ListingTarget,
  type TargetDescription,
  type TargetSpec,
} from "./types.ts";

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
 * is logged against, and that they always mean a group rather than one person. */
const listingScoped = {
  logListingId: (target: { listingId: number }): number => target.listingId,
  singleRecipient: false,
} as const;

/** The query a listing-scoped target is reached by. One day adds its own day to
 * this rather than spelling the listing part out again. */
const listingQuery = (listingId: number): string => `?listing=${listingId}`;

export const listingSpec: TargetSpec<ListingTarget> = {
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

// ── One day of a listing ────────────────────────────────────────────

/**
 * Read a day target from a request's params.
 *
 * Naming a `day` field at all is what claims the request for this target, so a
 * request that carries one and cannot produce a valid day target is refused
 * rather than handed on. Widening is the danger the other way round: a blank
 * day would otherwise reach the whole listing, and a day with no listing beside
 * it would reach the default audience, both of them far more people than the
 * request asked for. The whole-listing form omits the field entirely, which is
 * how it still falls through to its own target.
 */
const listingDayTargetFrom = async (
  params: URLSearchParams,
  listingKey: string,
): Promise<ListingDayTarget | null | undefined> => {
  if (!params.has("day")) return;
  const day = params.get("day")?.trim() ?? "";
  const id = parsePositiveIntId(params.get(listingKey)?.trim() ?? "");
  if (id === null || !isIsoDate(day)) return null;
  const listing = await getListingWithCount(id);
  return listing ? { day, kind: "listing-day", listingId: id } : null;
};

export const listingDaySpec: TargetSpec<ListingDayTarget> = {
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
  fromForm: (form) => listingDayTargetFrom(form, "listing_id"),
  fromQuery: (params) => listingDayTargetFrom(params, "listing"),
  loadPiiBlobs: (target) =>
    getAttendeePiiBlobsForListingDay(target.listingId, dateToRange(target.day)),
  toQuery: (target) => `${listingQuery(target.listingId)}&day=${target.day}`,
};
