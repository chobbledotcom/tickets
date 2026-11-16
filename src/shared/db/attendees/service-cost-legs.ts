/**
 * The ledger legs of service costs: each original cost leg, and the
 * adjustment legs that later edits post against it.
 */

import { KIND } from "#accounting/kinds.ts";
import type { TransferEndpoints } from "#accounting/rows.ts";
import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { queryAll, queryOne } from "#db/client.ts";
import { sql, sqlList, sqlLiteral } from "#db/sql.ts";
import { requiredMapValue, sumByKey, unique } from "#fp";

/** The narrow transfers columns a service-cost read needs: the row's id and
 * amount plus the shared account endpoints (to see which side is the cost
 * account), and the encrypted memo where selected. */
type CostRow = TransferEndpoints & {
  id: number;
  amount: number;
  memo?: EnvKeyEncrypted;
};

const COST_ROW_SELECT = sql`id, source_type, source_id, dest_type, dest_id, amount`;

const getCostRow = async (costId: number): Promise<CostRow | null> =>
  queryOne<CostRow>(
    sql`SELECT ${COST_ROW_SELECT}
       FROM transfers
      WHERE id = ${costId} AND kind = ${sqlLiteral(KIND.serviceCost)}`,
  );

export const loadCostRow = async (costId: number): Promise<CostRow> => {
  const row = await getCostRow(costId);
  if (!row) throw new Error("service cost not found");
  return row;
};

/** The listing id a `service_cost` transfer attributes its cost to: the cost
 *  account is `source` for a `cost:L → world` leg and `destination` for a
 *  `world → cost:L` reduction leg, so the listing id is on whichever side is
 *  the `cost` account. */
export const costListingId = (row: CostRow): number =>
  Number(row.source_type === "cost" ? row.source_id : row.dest_id);

/** A derived, operator-facing service-cost record for `/admin/servicing/:id`'s
 *  cost list: the original cost leg's id (the edit route target), its current
 *  amount (original ± adjustment legs), the service date, the listing it was
 *  attributed to, and the decrypted operator memo. */
export type ServicingCostRecord = {
  amount: number;
  date: string;
  id: number;
  listingId: number;
  memo: string;
};

/** Machine-generated memo written into adjustment legs so they can be
 *  attributed back to their original cost. The `\x00` prefix makes it
 *  impossible to collide with a free-text operator memo (form input cannot
 *  contain NUL bytes). */
export const ADJ_MEMO_PREFIX = "\x00svc_adj:";
const EDIT_COST_MEMO = new RegExp(`^${ADJ_MEMO_PREFIX}(\\d+)$`);

/** A decoded `service_cost` leg: its id and amount, whether it RAISED the cost
 *  (source is the cost account), and — for an adjustment leg — the id of the
 *  original cost it corrects (null for an original cost leg). */
type DecodedCostLeg = {
  id: number;
  amount: number;
  isIncrease: boolean;
  adjustsOriginalId: number | null;
};

/** Load and decode every `service_cost` leg attributed to any of `listingIds`
 *  in one query, decrypting each memo to classify it as an original cost leg or
 *  an adjustment naming the original it corrects. Shared by {@link editServiceCost}
 *  (current amount of one cost) and {@link getServicingCosts} (current amount of
 *  every cost) so the leg query and the memo classification live in one place. */
export const loadServiceCostLegs = async (
  listingIds: number[],
): Promise<DecodedCostLeg[]> => {
  // Both callers pass a non-empty set (getServicingCosts guards on
  // records.length; editServiceCost passes the cost's single listing), so no
  // empty-set guard — an empty `IN ()` would be a caller bug, not a silent [].
  const ids = listingIds.map(String);
  const inIds = sqlList(ids);
  const legs = await queryAll<CostRow>(
    sql`SELECT ${COST_ROW_SELECT}, memo FROM transfers
      WHERE kind = ${sqlLiteral(KIND.serviceCost)}
        AND ((source_type = 'cost' AND source_id IN (${inIds}))
          OR (dest_type = 'cost' AND dest_id IN (${inIds})))
      ORDER BY id`,
  );
  return Promise.all(
    legs.map(async (leg): Promise<DecodedCostLeg> => {
      const match = (await decrypt(leg.memo!)).match(EDIT_COST_MEMO);
      return {
        adjustsOriginalId: match ? Number(match[1]) : null,
        amount: leg.amount,
        id: leg.id,
        isIncrease: leg.source_type === "cost",
      };
    }),
  );
};

/** Fold decoded legs into (original cost id → net signed adjustment): an
 *  increase leg adds its amount, a reduction leg subtracts it; original
 *  (non-adjustment) legs contribute nothing. */
export const sumAdjustmentsByOriginal = (
  legs: DecodedCostLeg[],
): Map<number, number> =>
  sumByKey(
    (leg: DecodedCostLeg) => leg.adjustsOriginalId!,
    (leg) => (leg.isIncrease ? leg.amount : -leg.amount),
  )(legs.filter((leg) => leg.adjustsOriginalId !== null));

/**
 * The service-cost records recorded against one service event, each with its
 * CURRENT amount derived from the append-only ledger: the original `cost:L`
 * leg (linked via `service_costs.transfer_id`) plus every `service_cost`
 * adjustment leg whose memo names that original (`edit service cost {id}`).
 * Members are stored PII-free / owner-key-encrypted, so the memo decrypts with
 * the global key here for display.
 */
export const getServicingCosts = async (
  servicingId: number,
): Promise<ServicingCostRecord[]> => {
  const records = await queryAll<{
    transfer_id: number;
    listing_id: number;
    occurred_at: string;
    memo: EnvKeyEncrypted;
  }>(
    sql`SELECT transfer_id, listing_id, occurred_at, memo FROM service_costs WHERE servicing_attendee_id = ${servicingId} ORDER BY occurred_at, transfer_id`,
  );
  if (records.length === 0) return [];
  const legs = await loadServiceCostLegs(
    unique(records.map((r) => r.listing_id)),
  );
  const adjustmentsByOriginal = sumAdjustmentsByOriginal(legs);
  const baseAmountById = new Map(legs.map((leg) => [leg.id, leg.amount]));
  const costAmount = (id: number): number =>
    requiredMapValue(baseAmountById, id, `Transfer ${id} missing`) +
    (adjustmentsByOriginal.get(id) ?? 0);
  // Build the result as a pure map over `records`, already ordered by
  // (occurred_at, transfer_id): Promise.all keeps that order, so the cost
  // list cannot shuffle under concurrent decryption.
  return Promise.all(
    records.map(
      async (r): Promise<ServicingCostRecord> => ({
        amount: costAmount(r.transfer_id),
        date: r.occurred_at,
        id: r.transfer_id,
        listingId: r.listing_id,
        memo: await decrypt(r.memo!),
      }),
    ),
  );
};
