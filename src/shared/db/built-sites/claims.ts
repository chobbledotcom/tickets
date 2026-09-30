/**
 * Claiming pooled sites for plan buyers. The claim is a single conditional
 * UPDATE guarded by `assignable`, so two racing requests for the same site
 * cannot both win; the check-then-claim pair runs in one write transaction,
 * so two racing notification runs for the same buyer cannot take a site each.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { builtSites, requireBuiltSiteByIdPrimary } from "#db/built-sites.ts";
import {
  execute,
  inPlaceholders,
  type SqlStatement,
  withTransaction,
} from "#db/client.ts";

/** One statement over a buyer's site assignments: the select list and the
 * trailing clause vary, the attendee and the listing filter do not. */
export const buyerAssignmentStatement = (
  { select, tail = "" }: { select: string; tail?: string },
  attendeeId: number,
  listingIds: readonly number[],
): SqlStatement => ({
  args: [attendeeId, ...listingIds],
  sql: `SELECT ${select} FROM built_sites
     WHERE assigned_attendee_id = ?
       AND assigned_listing_id IN (${inPlaceholders(listingIds)})${tail}`,
});

/** A statement scoped to one buyer's plan listings. */
export type BuyerPlanStatement = (
  attendeeId: number,
  listingIds: readonly number[],
) => SqlStatement;

/** Curry the buyer-assignment statement over its select list and tail. */
export const buyerAssignmentStatementFor =
  (parts: { select: string; tail?: string }): BuyerPlanStatement =>
  (attendeeId, listingIds) =>
    buyerAssignmentStatement(parts, attendeeId, listingIds);

export const assignedBuiltSiteExistsStatement: BuyerPlanStatement =
  buyerAssignmentStatementFor({ select: "1", tail: " LIMIT 1" });

export const hasAssignedBuiltSite = async (
  attendeeId: number,
  listingIds: number[],
): Promise<boolean> => {
  const exists = assignedBuiltSiteExistsStatement(attendeeId, listingIds);
  return (await execute(exists.sql, exists.args)).rows.length > 0;
};

/** The claim as one statement: it takes the first still-assignable candidate,
 * in the pool order the caller passes. It also bumps the blob revision so a
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

/** One buyer's take from the pool: a claimed site, a read that the buyer was
 * already served (with the site their earlier claim gave them), or an empty
 * pool. */
export type PooledSiteTake =
  | { kind: "claimed"; site: BuiltSite }
  | { kind: "served"; site: BuiltSite }
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
    /** The site the buyer holds on these listings, as this take's answer. */
    const heldSite = async <Kind extends "served" | "won">(
      kind: Kind,
      onListings: readonly number[],
    ) => {
      const claimed = await tx.execute(
        claimedSiteIdStatement(attendeeId, onListings),
      );
      return { kind, siteId: claimed.rows[0]!.id as number };
    };
    const served = await tx.execute(
      assignedBuiltSiteExistsStatement(attendeeId, listingIds),
    );
    if (served.rows.length > 0) return heldSite("served", listingIds);
    const won = await tx.execute(
      claimBuiltSiteStatement(candidateIds, attendeeId, listingIdToRecord),
    );
    if (won.rowsAffected === 0) return null;
    return heldSite("won", [listingIdToRecord]);
  });
  if (claim === null) return { kind: "empty" };
  const site = await requireBuiltSiteByIdPrimary(claim.siteId);
  if (claim.kind === "served") return { kind: "served", site };
  builtSites.invalidate();
  available.splice(
    available.findIndex((site) => site.id === claim.siteId),
    1,
  );
  // Read the claimed row back: a concurrent whole-row write may have landed
  // between the pool load and the claim, and the pool snapshot is stale.
  return { kind: "claimed", site };
};
