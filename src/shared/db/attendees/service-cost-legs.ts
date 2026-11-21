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

/** The transfer columns that a service-cost read needs: the id, the amount
 * and the account ends, which show the side of the cost account. A read
 * that selects the sealed memo adds it. */
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

/** The listing that a `service_cost` transfer charges. A `cost:L → world`
 *  leg holds the cost account as its source. A `world → cost:L` reduction
 *  leg holds it as its destination. */
export const costListingId = (row: CostRow): number =>
  Number(row.source_type === "cost" ? row.source_id : row.dest_id);

/** One service cost in the cost list of `/admin/servicing/:id`. The id is the
 *  id of the original cost leg, which the edit route takes. The amount is
 *  the original amount with each adjustment applied. The memo is opened. */
export type ServicingCostRecord = {
  amount: number;
  date: string;
  id: number;
  listingId: number;
  memo: string;
};

/** The start of the memo of an adjustment leg, which names its original
 *  cost. The `\x00` prefix cannot match a memo that an operator types,
 *  because form input cannot hold NUL bytes. */
export const ADJ_MEMO_PREFIX = "\x00svc_adj:";
const EDIT_COST_MEMO = new RegExp(`^${ADJ_MEMO_PREFIX}(\\d+)$`);

/** One `service_cost` leg: its id and amount, and whether it raised the
 *  cost. An adjustment leg also names the original cost that it corrects.
 *  An original cost leg names null. */
type DecodedCostLeg = {
  id: number;
  amount: number;
  isIncrease: boolean;
  adjustsOriginalId: number | null;
};

/** Every `service_cost` leg of these listings, read in one query. The memo
 *  of each leg tells an original cost leg from an adjustment. The edit of a
 *  cost and the cost list both use this read. */
export const loadServiceCostLegs = async (
  listingIds: number[],
): Promise<DecodedCostLeg[]> => {
  // Each caller gives at least one listing, so there is no guard for an
  // empty list. An empty `IN ()` is a bug in the caller.
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

/** The net adjustment of each original cost, by its id. An increase leg
 *  adds its amount, and a reduction leg takes it away. An original cost leg
 *  adds nothing. */
export const sumAdjustmentsByOriginal = (
  legs: DecodedCostLeg[],
): Map<number, number> =>
  sumByKey(
    (leg: DecodedCostLeg) => leg.adjustsOriginalId!,
    (leg) => (leg.isIncrease ? leg.amount : -leg.amount),
  )(legs.filter((leg) => leg.adjustsOriginalId !== null));

/**
 * The service costs of one service event. The ledger only adds rows, so the
 * current amount of a cost is its original `cost:L` leg plus each adjustment
 * leg whose memo names that leg. The global key opens each memo for display.
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
    requiredMapValue(baseAmountById, id) + (adjustmentsByOriginal.get(id) ?? 0);
  // The records come in date order. Promise.all keeps that order, so the
  // list does not move while the memos open.
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
