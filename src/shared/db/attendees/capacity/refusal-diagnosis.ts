/**
 * The refusal diagnosis: which line of a refused order first tipped it over
 * capacity. The guarded write cannot say which statement it aborted on, so
 * the order is asked again as prefix searches on the primary — pure probe
 * plans in this module's helpers, the one batch ask going through
 * `queryBatchPrimary`. (src/shared/db/attendees/capacity/checks.ts keeps the
 * write-time capacity predicates and the shared demand buckets.)
 */

import type { LineBooking } from "#db/attendee-types.ts";
import { buildCartCapacitySql, type CartDemand } from "#db/capacity-batch.ts";
import { inPlaceholders, queryBatchPrimary, resultRows } from "#db/client.ts";
import { requiredMapValue, unique } from "#fp";
import { addDemandToBucket, getOrCreateBucket } from "./checks.ts";
import type { ListingCapacityRow } from "./types.ts";

type LineListingFacts = {
  groupIds: number[];
  listing_type: ListingCapacityRow["listing_type"];
};

/** One cart demand for a slice of lines, each line counted on its own date. */
const linesDemand = (
  lines: LineBooking[],
  factsById: Map<number, LineListingFacts>,
): CartDemand => {
  const demand: CartDemand = {
    groupDemand: new Map(),
    listingDemand: new Map(),
  };
  for (const line of lines) {
    const facts = requiredMapValue(
      factsById,
      line.listingId,
      `Listing ${line.listingId} was not read for the refusal diagnosis`,
    );
    const item = {
      durationDays: line.durationDays,
      listingId: line.listingId,
      quantity: line.quantity,
    };
    addDemandToBucket(
      getOrCreateBucket(demand.listingDemand, line.listingId),
      facts,
      item,
      line.date,
    );
    for (const groupId of facts.groupIds) {
      addDemandToBucket(
        getOrCreateBucket(demand.groupDemand, groupId),
        facts,
        item,
        line.date,
      );
    }
  }
  return demand;
};

/** Prefixes one probe batch samples. Eight keeps a whole typical order's
 * diagnosis inside ONE snapshot batch; a longer order narrows its bracket by
 * this factor per batch, so the statements per request stay bounded however
 * many lines the order has — one statement per prefix would grow the request
 * with the square of the length. The whole-order probe rides every batch, so
 * a room freed between batches still names no listing. */
const PROBE_STRIDE = 8;

/** The prefixes one batch asks: evenly by stride from the fitting end of
 * the bracket, plus the bracket ends and the whole order. */
const batchProbePrefixes = (
  longestFit: number,
  shortestUnfit: number,
  orderLength: number,
): number[] => {
  const step = Math.ceil((shortestUnfit - longestFit) / PROBE_STRIDE);
  const sampled: number[] = [];
  for (let prefix = longestFit + step; prefix < shortestUnfit; prefix += step) {
    sampled.push(prefix);
  }
  // Ascending, so the bracket walk below finds the first unfit prefix in
  // numeric order rather than insertion order.
  return unique([
    ...sampled,
    ...(longestFit > 0 ? [longestFit] : []),
    shortestUnfit,
    orderLength,
  ]).sort((left, right) => left - right);
};

/** Ask one batch of prefixes through one primary snapshot. */
const askWhetherPrefixesFit = async (
  lines: LineBooking[],
  factsById: Map<number, LineListingFacts>,
  probes: readonly number[],
): Promise<Map<number, boolean>> => {
  const results = await queryBatchPrimary(
    probes.map((prefix) =>
      buildCartCapacitySql(linesDemand(lines.slice(0, prefix), factsById)),
    ),
  );
  return new Map(
    probes.map((prefix, index) => [
      prefix,
      resultRows<{ fits: number }>(results[index]!)[0]!.fits === 1,
    ]),
  );
};

/** The index of the first line that does not fit, found by stride batches
 * over the order's prefixes: a typical order's whole search is one snapshot
 * batch, a longer one narrows a bracket by the stride factor per batch.
 * Every batch probes the bracket ends it carries: a room freed between
 * batches makes the whole order fit again and names nothing, and a room
 * consumed outruns the fitting bound, whose failure sends the bracket back
 * to the start. A line is named only when one batch proves an adjacent
 * prefix pair — fitting below, unfit above. Null means nothing is proven
 * at a snapshot, and no line is named. */
const firstUnfitLineIndex = async (
  lines: LineBooking[],
  factsById: Map<number, LineListingFacts>,
): Promise<number | null> => {
  let longestFit = 0;
  let shortestUnfit = lines.length;
  // The budget keeps a room that changes between every batch from spinning
  // the search forever; running it out names nothing below.
  for (let batch = 0; batch < lines.length; batch++) {
    const probes = batchProbePrefixes(longestFit, shortestUnfit, lines.length);
    const fits = await askWhetherPrefixesFit(lines, factsById, probes);
    // The whole order fitting again at this snapshot means the room was
    // freed again and no line is named.
    if (fits.get(lines.length)) return null;
    // The smallest probe IS the carried fitting bound when it is above
    // zero, so a booking that outran it makes it the first unfit prefix and
    // the bracket falls back to (0, bound] on its own — the next batch
    // re-metres from the start.
    const firstUnfit = probes.find((prefix) => !fits.get(prefix))!;
    const fittingBefore = probes[probes.indexOf(firstUnfit) - 1] ?? 0;
    if (firstUnfit - fittingBefore <= 1) return firstUnfit - 1;
    longestFit = fittingBefore;
    shortestUnfit = firstUnfit;
  }
  // The budget ran out with no adjacent probed pair, so the room kept
  // changing between snapshots and no line is proven the culprit: an
  // unproven guess would name a line that may fit right now.
  return null;
};

/** The listing whose line first tipped a guarded write over capacity — the
 * statement the write aborted on, named by prefix searches over the refused
 * order. A shared group limit counts, whatever dates the lines sit on.
 *
 * The reads run on the primary because the refused write did. A replica can
 * lag behind the booking that took the last place, and the isolate's caches
 * can hold a listing another isolate deleted. */
export const refusedOrderUnfitListingIds = async (
  lines: LineBooking[],
): Promise<number[]> => {
  if (lines.length === 0) return [];
  const listingIds = unique(lines.map((line) => line.listingId));
  const [listingResult, memberResult] = await queryBatchPrimary([
    {
      args: listingIds,
      sql: `SELECT listing.id, listing.listing_type
              FROM listings AS listing
             WHERE listing.id IN (${inPlaceholders(listingIds)})`,
    },
    {
      args: listingIds,
      sql: `SELECT groupListing.listing_id, groupListing.group_id
              FROM group_listings AS groupListing
             WHERE groupListing.listing_id IN (${inPlaceholders(listingIds)})`,
    },
  ]);
  const factsById = new Map<number, LineListingFacts>(
    resultRows<Pick<ListingCapacityRow, "id" | "listing_type">>(
      listingResult!,
    ).map((row) => [row.id, { groupIds: [], listing_type: row.listing_type }]),
  );
  if (listingIds.some((id) => !factsById.has(id))) return [];
  for (const row of resultRows<{ group_id: number; listing_id: number }>(
    memberResult!,
  )) {
    requiredMapValue(
      factsById,
      row.listing_id,
      `Group membership row for an unrequested listing ${row.listing_id}`,
    ).groupIds.push(row.group_id);
  }

  const firstUnfit = await firstUnfitLineIndex(lines, factsById);
  return firstUnfit === null ? [] : [lines[firstUnfit]!.listingId];
};
