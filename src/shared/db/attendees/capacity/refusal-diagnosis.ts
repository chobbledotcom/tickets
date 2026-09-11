/**
 * The refusal diagnosis: which line of a refused order first tipped it over
 * capacity. The guarded write cannot say which statement it aborted on, so
 * the order is asked again as prefix searches on the primary — pure probe
 * plans in this module's helpers, the one batch ask going through
 * `queryBatchPrimary`. (src/shared/db/attendees/capacity/checks.ts keeps the
 * write-time capacity predicates and the shared demand buckets.)
 */

import type { ResultSet } from "@libsql/client";
import type { LineBooking } from "#db/attendee-types.ts";
import {
  addDemandToBucket,
  buildCartCapacitySql,
  type CartDemand,
  getOrCreateBucket,
} from "#db/capacity-batch.ts";
import {
  inPlaceholders,
  queryBatchPrimary,
  resultRows,
  type SqlStatement,
} from "#db/client.ts";
import { requiredMapValue, unique } from "#fp";
import { MAX_FORM_LINES } from "#shared/limits.ts";
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

/** Probing batches one diagnosis may spend: enough for the longest order
 * the form cap allows to narrow its bracket to the tipping line, with
 * headroom for a mid-search booking to reset the search a few times. Past
 * the bound a room that moved under every batch names nothing instead of
 * paying for more probes, and the answer stays inside one request's
 * database-call budget however long the order is. */
const MAX_PROBE_BATCHES =
  Math.ceil(Math.log(MAX_FORM_LINES) / Math.log(PROBE_STRIDE)) + 4;

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

/** The two facts SELECTs one batch re-reads: the order's listing rows and
 * their group memberships. The pre-search batch and every probe batch share
 * them. */
const buildFactsStatements = (
  listingIds: readonly number[],
): SqlStatement[] => [
  {
    args: [...listingIds],
    sql: `SELECT listing.id, listing.listing_type
            FROM listings AS listing
           WHERE listing.id IN (${inPlaceholders(listingIds)})`,
  },
  {
    args: [...listingIds],
    sql: `SELECT groupListing.listing_id, groupListing.group_id
            FROM group_listings AS groupListing
           WHERE groupListing.listing_id IN (${inPlaceholders(listingIds)})`,
  },
];

/** Fold two facts result sets into the model the probes build their demands
 * from, and report an order listing the snapshot no longer knows — either a
 * listing row is gone, or a membership row outlives its listing. */
const readFacts = (
  listingIds: readonly number[],
  listingResult: ResultSet,
  memberResult: ResultSet,
): { facts: Map<number, LineListingFacts>; vanished: boolean } => {
  const facts = new Map<number, LineListingFacts>(
    resultRows<Pick<ListingCapacityRow, "id" | "listing_type">>(
      listingResult,
    ).map((row) => [row.id, { groupIds: [], listing_type: row.listing_type }]),
  );
  const vanished = listingIds.some((id) => !facts.has(id));
  for (const row of resultRows<{ group_id: number; listing_id: number }>(
    memberResult,
  )) {
    const listing = facts.get(row.listing_id);
    if (listing === undefined) continue;
    listing.groupIds.push(row.group_id);
  }
  return { facts, vanished };
};

/** Whether the facts the probe batch's demands were built from still hold at
 * the batch's own snapshot: every listing's type and group ids, member by
 * member. The two models come from two reads at different snapshots, and
 * either read can return a membership in a different row order, so each
 * listing's ids sort before the compare. A change in the type or a group
 * membership breaks the match and voids the batch. */
const listingFactsChanged = (
  withDemand: Map<number, LineListingFacts>,
  atSnapshot: Map<number, LineListingFacts>,
): boolean => {
  const factsInRowOrder = (facts: Map<number, LineListingFacts>): unknown =>
    [...facts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([id, listing]) => [
        id,
        listing.listing_type,
        [...listing.groupIds].sort((left, right) => left - right),
      ]);
  return (
    JSON.stringify(factsInRowOrder(withDemand)) !==
    JSON.stringify(factsInRowOrder(atSnapshot))
  );
};

/** One batch's verdict: the fits, the facts to build the next batch from, and
 * whether the facts moved under this batch (or a listing vanished), which
 * voids the fits. */
type ProbeBatch = {
  factsById: Map<number, LineListingFacts>;
  fits: Map<number, boolean> | null;
  vanished: boolean;
};

/** Ask one batch of prefixes through one primary snapshot. The batch also
 * re-reads the order's listing facts beside its probes, so a batch's fits
 * count only when the facts its demands were built from still held at the
 * batch's own snapshot: a membership or type change can only void the batch,
 * never steer its answer. */
const askWhetherPrefixesFit = async (
  lines: LineBooking[],
  factsById: Map<number, LineListingFacts>,
  probes: readonly number[],
  listingIds: readonly number[],
): Promise<ProbeBatch> => {
  const results = await queryBatchPrimary([
    ...probes.map((prefix) =>
      buildCartCapacitySql(linesDemand(lines.slice(0, prefix), factsById)),
    ),
    ...buildFactsStatements(listingIds),
  ]);
  const fresh = readFacts(
    listingIds,
    results[probes.length]!,
    results[probes.length + 1]!,
  );
  const fits =
    fresh.vanished || listingFactsChanged(factsById, fresh.facts)
      ? null
      : new Map(
          probes.map((prefix, index) => [
            prefix,
            resultRows<{ fits: number }>(results[index]!)[0]!.fits === 1,
          ]),
        );
  return {
    factsById: fresh.vanished ? factsById : fresh.facts,
    fits,
    vanished: fresh.vanished,
  };
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
  listingIds: readonly number[],
): Promise<number | null> => {
  let longestFit = 0;
  let shortestUnfit = lines.length;
  for (let batch = 0; batch < MAX_PROBE_BATCHES; batch++) {
    const probes = batchProbePrefixes(longestFit, shortestUnfit, lines.length);
    const asked = await askWhetherPrefixesFit(
      lines,
      factsById,
      probes,
      listingIds,
    );
    // An order listing vanished: the refusal cause cannot be proven on a
    // listing that no longer exists, so no line is named.
    if (asked.vanished) return null;
    if (asked.fits === null) {
      // The facts moved under this batch — a membership or type change.
      // The batch proves nothing; the next one re-metres on the fresh facts.
      factsById = asked.factsById;
      continue;
    }
    const fits = asked.fits;
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
  const [listingResult, memberResult] = await queryBatchPrimary(
    buildFactsStatements(listingIds),
  );
  const { facts: factsById, vanished } = readFacts(
    listingIds,
    listingResult!,
    memberResult!,
  );
  // A vanished listing cannot carry the refusal cause, and a request that
  // names a listing without facts would guess at its demand.
  if (vanished) return [];

  const firstUnfit = await firstUnfitLineIndex(lines, factsById, listingIds);
  return firstUnfit === null ? [] : [lines[firstUnfit]!.listingId];
};
