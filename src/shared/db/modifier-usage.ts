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
import { inPlaceholders, queryAll } from "#shared/db/client.ts";
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
