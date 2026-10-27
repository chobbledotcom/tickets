/**
 * Shared planning types and pure helpers for the bundle import. They carry
 * the document's items, references, and memberships between validation and
 * the write. The small rule adapters here serve both phases.
 *
 * Every reference is a name. It resolves either to an item of the document
 * (keyed by its normalised name) or to a row that exists on the site (its
 * id). Names are unique across listings and groups, inside the document and
 * on the site. A name is therefore an unambiguous key.
 */

import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { listingInputToEdge } from "#shared/listing-edge.ts";
import type { EdgeListing } from "#shared/listing-parents-rules.ts";
import {
  memberBlockKey,
  packageMemberMessage,
  packageMemberQuantityError,
} from "#shared/package-membership.ts";
import type { DayPricedListing, DayPrices, ListingWithCount } from "#types";
import { siteIdsOfRefs } from "./bundle-refs.ts";
import { memberDayPriceError } from "./import-listing.ts";
import type { GroupBody } from "./schema.ts";

/** What a successful bundle import created. */
export type ImportedBundle = {
  groups: number;
  kind: "bundle";
  listings: number;
};

/** One failed item: its name, then each reason nothing was created. */
export type BundleFailure = { item: string; reasons: string[] };

/** A membership's write fields before the rows it joins exist. */
export type PlannedMembership = {
  dayPrices: DayPrices;
  packagePrice: number | null;
  quantity: number;
};

/** Where one referenced name resolves: an item of this document (its key) or
 * a row that already exists on the site (its id). */
export type BundleRef = { bundleKey: string } | { siteId: number };

/** One membership to write, between a named listing and a named group. */
export type PlannedPair = {
  group: BundleRef;
  listing: BundleRef;
  spec: PlannedMembership;
};

/** One parent edge to write, from a planned child to a planned or stored
 * parent. */
export type PlannedEdge = { child: BundleRef; parent: BundleRef };

/** One planned listing: its insert input (slug added at write time) and the
 * parent keys it declares. Membership specs travel in the pair list. */
export type ListingPlan = {
  input: ListingInput;
  parentKeys: string[];
};

/** One planned group: the document body its insert input is built from at
 * write time (the slug is minted there). */
export type GroupPlan = {
  body: GroupBody;
};

/** The bundle's validated plan, ready to write. */
export type BundlePlan = {
  edges: PlannedEdge[];
  groupPlans: GroupPlan[];
  listingPlans: ListingPlan[];
  pairs: PlannedPair[];
};

/** The failure message for one item: the item name, then each reason. */
export const describeFailure = ({ item, reasons }: BundleFailure): string =>
  reasons.map((reason) => `"${item}": ${reason}`).join("; ");

/** Do two membership declarations land the same row? Overrides the write
 * drops (a non-package group's quantity, say) normalise away first. Only a
 * difference that matters counts as a conflict. */
export const sameMembership = (
  a: PlannedMembership,
  b: PlannedMembership,
): boolean =>
  a.packagePrice === b.packagePrice &&
  a.quantity === b.quantity &&
  sameDayPrices(a.dayPrices, b.dayPrices);

const sameDayPrices = (a: DayPrices, b: DayPrices): boolean => {
  const entries = Object.entries(a);
  return (
    entries.length === Object.keys(b).length &&
    entries.every(([days, price]) => b[Number(days)] === price)
  );
};

/** The site group ids inside a list of membership pairs: the site rows the
 * write links the listings to. */
export const siteGroupIdsOfPairs = (pairs: Iterable<PlannedPair>): number[] =>
  siteIdsOfRefs([...pairs].map((pair) => pair.group));

/** The stored listing row projected onto the edge-compatibility shape. */
export const edgeListingOfRow = (row: ListingWithCount): EdgeListing => ({
  assign_built_site: row.assign_built_site,
  customisable_days: row.customisable_days,
  day_prices: row.day_prices,
  duration_days: row.duration_days,
  id: row.id,
  listing_type: row.listing_type,
  min_quantity: row.min_quantity,
  months_per_unit: row.months_per_unit,
  name: row.name,
});

/** The planned listing projected onto the same shape. The id is not the
 * row's id, because the row does not exist yet. The edge rules read the
 * fields, never the id. */
export const edgeListingOfPlan = (plan: ListingPlan): EdgeListing =>
  listingInputToEdge(plan.input, 0);

/** The package-member refusal for a planned listing judged as a group
 * member. The buyer cannot price it, and a listing with parent references is
 * an add-on. A planned listing has no children yet. */
export const bundlePackageMemberError = (
  plan: ListingPlan,
  hideListings: boolean | undefined,
): string | null => {
  // A planned listing's parent references carry no id yet. The rule reads
  // only whether the list is empty, so one placeholder stands in for them.
  const key = memberBlockKey(
    { can_pay_more: plan.input.canPayMore ?? false },
    { childIds: [], parentIds: plan.parentKeys.length === 0 ? [] : [0] },
    hideListings,
  );
  return key === null ? null : packageMemberMessage(key, plan.input.name);
};

/** Both package-member checks for one member: the pick count, then the
 * day-price overrides. Every refusal found, in the order the single import
 * raises them. */
export const packageMemberRefusals = (
  name: string,
  quantities: { max_quantity: number; min_quantity: number },
  spec: PlannedMembership,
  dayFields: DayPricedListing,
): string[] => {
  const refusals: string[] = [];
  const quantityError = packageMemberQuantityError(name, {
    ...quantities,
    quantity: spec.quantity,
  });
  if (quantityError !== null) refusals.push(quantityError);
  const dayError = memberDayPriceError(name, spec.dayPrices, dayFields);
  if (dayError !== null) refusals.push(dayError);
  return refusals;
};
