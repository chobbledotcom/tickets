/** The named-audience target: "everyone booked onto an active listing", and
 * its two siblings. The catch-all target, so its parsers always produce one. */

import {
  getAllAttendeePiiBlobs,
  getAttendeePiiBlobsForListings,
} from "#db/attendees/queries.ts";
import { getAllListings } from "#db/listings/records.ts";
import { filter, map } from "#fp";
import type { ListingWithCount } from "#types";
import {
  AUDIENCES,
  type AudienceId,
  type AudienceTarget,
  audienceById,
  BULK_COMPOSE_COPY,
  DEFAULT_AUDIENCE_ID,
  isAudienceId,
  type TargetSpec,
} from "./types.ts";

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

export const audienceSpec: TargetSpec<AudienceTarget> = {
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
