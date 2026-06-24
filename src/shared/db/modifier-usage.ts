/**
 * Modifier stock: the usage ledger and atomic consumption.
 *
 * Stock is tracked by recording one `modifier_usages` row per applied modifier
 * (never by mutating a counter), so a modifier's remaining stock can only fall
 * or hold — exactly the capacity pattern used for listing attendees. The
 * consuming insert is guarded by the live remaining count, so two concurrent
 * checkouts can never oversell the last unit.
 */

import type { InValue } from "@libsql/client";
import {
  execute,
  executeBatchWithResults,
  inPlaceholders,
  queryAll,
  type TxScope,
} from "#shared/db/client.ts";
import { mapByIds } from "#shared/db/query.ts";
import { nowIso } from "#shared/now.ts";

/** One modifier consumed by an order: the modifier, how many, and the amount
 * it changed the order by (recorded for reporting). */
export type ModifierUsage = {
  modifierId: number;
  quantity: number;
  amountApplied: number;
};

/** A built SQL fragment: the text and its positional bind args. */
type SqlFragment = { sql: string; args: InValue[] };

/** Used quantity per modifier id, for remaining-stock checks at resolve time. */
export const modifierUsedQuantities = (
  ids: number[],
): Promise<Map<number, number>> =>
  mapByIds<{ modifier_id: number; used: number }>(
    ids,
    (placeholders) =>
      `SELECT modifier_id, COALESCE(SUM(quantity), 0) AS used
       FROM modifier_usages WHERE modifier_id IN (${placeholders})
       GROUP BY modifier_id`,
    (row) => [row.modifier_id, row.used],
  );

/**
 * SQL predicate that holds while a modifier has at least `usage.quantity` units
 * left (unlimited when its stock is null). The single source of truth for "is
 * this modifier in stock", shared by the guarded usage insert (its own
 * concurrency guard) and by the booking insert that must refuse to land when a
 * chosen modifier sold out mid-payment. Wrapped in parens so several can be
 * AND-ed safely. */
export const modifierStockCondition = (usage: ModifierUsage): SqlFragment => ({
  args: [usage.modifierId, usage.modifierId, usage.modifierId, usage.quantity],
  sql: `((SELECT stock FROM modifiers WHERE id = ?) IS NULL
           OR (SELECT stock FROM modifiers WHERE id = ?)
              - COALESCE(
                  (SELECT SUM(quantity) FROM modifier_usages WHERE modifier_id = ?),
                  0
                ) >= ?)`,
});

/**
 * The AND of every chosen modifier's {@link modifierStockCondition}, for folding
 * into a booking insert's WHERE so the booking lands only when *all* its
 * modifiers still have stock. With no modifiers this is the always-true `1 = 1`,
 * so the booking's capacity clause stands alone. */
export const allModifiersInStockCondition = (
  usages: ModifierUsage[],
): SqlFragment => {
  if (usages.length === 0) return { args: [], sql: "1 = 1" };
  const parts = usages.map(modifierStockCondition);
  return {
    args: parts.flatMap((p) => p.args),
    sql: parts.map((p) => p.sql).join(" AND "),
  };
};

/**
 * One guarded `modifier_usages` insert — the single place the usage column list
 * and SELECT shape live. `attendeeIdExpr` is the SQL yielding the attendee id: a
 * literal `?` (its value in `attendeeIdArgs`) for the direct insert, or a
 * `(SELECT MAX(id) …)` subquery for the single-batch booking path where the
 * attendee row is inserted earlier in the same batch. The row lands only while
 * `guard` holds — the live stock count for a direct insert (its own concurrency
 * guard), or the all-bookings-landed gate for the batch path (where the booking
 * insert it accompanies already refused to land unless every modifier had
 * stock, so no separate stock guard is needed here). */
export const usageInsert = (
  usage: ModifierUsage,
  attendeeIdExpr: string,
  attendeeIdArgs: InValue[],
  guard: SqlFragment,
): SqlFragment => ({
  args: [
    usage.modifierId,
    ...attendeeIdArgs,
    usage.quantity,
    usage.amountApplied,
    nowIso(),
    ...guard.args,
  ],
  sql: `INSERT INTO modifier_usages
          (modifier_id, attendee_id, quantity, amount_applied, created)
        SELECT ?, ${attendeeIdExpr}, ?, ?, ?
        WHERE ${guard.sql}`,
});

/** Insert a usage row only while the modifier's remaining stock allows it
 * (unlimited when stock is null). Atomic, so it is also the concurrency guard. */
const guardedUsageInsert = (
  attendeeId: number,
  usage: ModifierUsage,
): SqlFragment =>
  usageInsert(usage, "?", [attendeeId], modifierStockCondition(usage));

/**
 * Whether any of these modifiers no longer has stock for its quantity — the
 * post-failure probe that tells a booking that failed to land *why*: a sold-out
 * add-on/discount (this returns true) versus the event itself filling up. Read
 * only on the failure path, so it never weighs on a successful checkout. A
 * null-stock (unlimited) or unknown modifier is never the sold-out cause. */
export const anyModifierSoldOut = async (
  usages: ModifierUsage[],
): Promise<boolean> => {
  const ids = usages.map((u) => u.modifierId);
  if (ids.length === 0) return false;
  const used = await modifierUsedQuantities(ids);
  const rows = await queryAll<{ id: number; stock: number | null }>(
    `SELECT id, stock FROM modifiers WHERE id IN (${inPlaceholders(ids)})`,
    ids,
  );
  const stockById = new Map(rows.map((r) => [r.id, r.stock]));
  return usages.some((u) => {
    const stock = stockById.get(u.modifierId);
    if (stock === null || stock === undefined) return false;
    return stock - (used.get(u.modifierId) ?? 0) < u.quantity;
  });
};

/**
 * Atomically consume stock for an attendee's modifiers. Returns true when every
 * usage was recorded; when any modifier had insufficient stock, the partial
 * rows recorded for this attendee are removed and false is returned (the caller
 * rolls the order back).
 */
export const consumeModifierStock = async (
  attendeeId: number,
  usages: ModifierUsage[],
): Promise<boolean> => {
  if (usages.length === 0) return true;
  const results = await executeBatchWithResults(
    usages.map((u) => guardedUsageInsert(attendeeId, u)),
  );
  if (results.every((r) => r.rowsAffected > 0)) return true;
  await execute("DELETE FROM modifier_usages WHERE attendee_id = ?", [
    attendeeId,
  ]);
  return false;
};

/**
 * Consume modifier stock inside an open transaction. Returns false as soon as a
 * modifier is sold out (a guarded insert affects no row); the caller rolls the
 * transaction back, so — unlike {@link consumeModifierStock} — no cleanup DELETE
 * is needed here. With no usages this is a no-op.
 */
export const consumeModifierStockTx = async (
  tx: TxScope,
  attendeeId: number,
  usages: ModifierUsage[],
): Promise<boolean> => {
  for (const usage of usages) {
    const result = await tx.execute(guardedUsageInsert(attendeeId, usage));
    if (result.rowsAffected === 0) return false;
  }
  return true;
};
