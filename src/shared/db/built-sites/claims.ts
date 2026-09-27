/**
 * Claiming pooled sites for plan buyers. The claim is a single conditional
 * UPDATE guarded by `assignable`, so two racing requests for the same site
 * cannot both win; the check-then-claim pair runs in one write transaction,
 * so two racing notification runs for the same buyer cannot take a site each.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  assignedBuiltSiteExistsStatement,
  type BuyerPlanStatement,
  builtSites,
  buyerAssignmentStatementFor,
  findBuiltSiteByIdPrimary,
} from "#db/built-sites.ts";
import { execute, type SqlStatement, withTransaction } from "#db/client.ts";

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
              ORDER BY poolOrder.key
              LIMIT 1
           )`,
});

/** The site a claim just won for this attendee: the row the claim statement
 * above now carries, found on any of the plan listings the buyer booked — a
 * combined purchase records only its first. Reads the plain assignment
 * columns, not the blob. */
export const claimedSiteIdStatement: BuyerPlanStatement =
  buyerAssignmentStatementFor({ select: "id" });

/** The site a claim gave this buyer on any of these plan listings, or null
 * when the buyer holds none. */
export const siteClaimedByBuyer = async (
  attendeeId: number,
  listingIds: readonly number[],
): Promise<BuiltSite | null> => {
  const { args, sql } = claimedSiteIdStatement(attendeeId, listingIds);
  const rows = (await execute(sql, args)).rows;
  const siteId = rows[0]?.id;
  if (typeof siteId !== "number") return null;
  return findBuiltSiteByIdPrimary(siteId);
};

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
      claimedSiteIdStatement(attendeeId, [listingIdToRecord]),
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
