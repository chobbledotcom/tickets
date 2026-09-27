/**
 * Claiming pooled sites for plan buyers. The claim is a single conditional
 * UPDATE guarded by `assignable`, so two racing requests for the same site
 * cannot both win; the check-then-claim pair runs in one write transaction,
 * so two racing notification runs for the same buyer cannot take a site each.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  assignedBuiltSiteExistsStatement,
  builtSites,
} from "#db/built-sites.ts";
import { type SqlStatement, withTransaction } from "#db/client.ts";

/** A statement scoped to one buyer's claim on one plan listing. */
type BuyerPlanStatement = (
  attendeeId: number,
  listingId: number,
) => SqlStatement;

/** The claim as one statement: it takes the first still-assignable candidate,
 * in the pool order the caller passes, and it bumps the blob revision so a
 * concurrent whole-row write cannot land a stale copy over the assignment.
 * One statement however large the pool, so the assignment transaction never
 * grows chatty. */
export const claimBuiltSiteStatement = (
  candidateIds: readonly number[],
  attendeeId: number,
  listingId: number,
): SqlStatement => ({
  args: [attendeeId, listingId, JSON.stringify(candidateIds)],
  sql: `UPDATE built_sites
           SET assignable = 0,
               assigned_attendee_id = ?,
               assigned_listing_id = ?,
               site_data_revision = site_data_revision + 1
         WHERE assignable = 1
           AND id = (
             SELECT candidate.id
               FROM json_each(?) AS poolOrder
               JOIN built_sites AS candidate ON candidate.id = poolOrder.value
              WHERE candidate.assignable = 1
              LIMIT 1
           )`,
});

/** The site a claim just won for this attendee: the row the claim statement
 * above now carries. Reads the plain assignment columns, not the blob. */
export const claimedSiteIdStatement: BuyerPlanStatement = (
  attendeeId,
  listingId,
) => ({
  args: [attendeeId, listingId],
  sql: `SELECT id FROM built_sites
         WHERE assigned_attendee_id = ? AND assigned_listing_id = ?`,
});

/** One buyer's take from the pool: a claimed site, a read that the buyer was
 * already served, or an empty pool. */
export type PooledSiteTake =
  | { kind: "claimed"; site: BuiltSite }
  | { kind: "served" }
  | { kind: "empty" };

/** Check the buyer is not already served and claim one pooled site, inside
 * one write transaction. Two racing notification runs for the same buyer
 * serialize here: the first claims, and the second reads the buyer already
 * served and wins nothing. The claim takes the first still-assignable
 * candidate, so a retried transaction re-runs identically. */
export const takePooledSiteForBuyer = async (
  available: BuiltSite[],
  attendeeId: number,
  listingIds: readonly number[],
  listingIdToRecord: number,
): Promise<PooledSiteTake> => {
  // Pop order: the last entry of `available` is the first candidate.
  const candidateIds = available.map((site) => site.id).reverse();
  const claim = await withTransaction(async (tx) => {
    const served = await tx.execute(
      assignedBuiltSiteExistsStatement(attendeeId, listingIds),
    );
    if (served.rows.length > 0) return { kind: "served" } as const;
    const won = await tx.execute(
      claimBuiltSiteStatement(candidateIds, attendeeId, listingIdToRecord),
    );
    if (won.rowsAffected === 0) return null;
    const claimed = await tx.execute(
      claimedSiteIdStatement(attendeeId, listingIdToRecord),
    );
    return { kind: "won", siteId: claimed.rows[0]!.id as number } as const;
  });
  if (claim === null) return { kind: "empty" };
  if (claim.kind === "served") return claim;
  builtSites.invalidate();
  const index = available.findIndex((site) => site.id === claim.siteId);
  const site = available.splice(index, 1)[0]!;
  return { kind: "claimed", site };
};
