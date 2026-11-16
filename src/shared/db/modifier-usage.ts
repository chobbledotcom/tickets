/**
 * Modifier stock: the usage ledger and atomic consumption.
 *
 * Stock is tracked by recording one `modifier_usages` row per applied modifier
 * (never by mutating a counter), so a modifier's remaining stock can only fall
 * or hold — exactly the capacity pattern used for listing attendees. The
 * consuming insert is guarded by the live remaining count, so two concurrent
 * checkouts can never oversell the last unit.
 */

import { queryOnePrimary } from "#db/client.ts";
import { readRows } from "#db/read.ts";
import { orZero, sum, valued } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlJoin } from "#db/sql.ts";
import { insertInto } from "#db/write.ts";
import { nowIso } from "#shared/now.ts";

/** One modifier consumed by an order: the modifier, how many, and the amount
 * it changed the order by (recorded for reporting). */
export type ModifierUsage = {
  modifierId: number;
  quantity: number;
  amountApplied: number;
};

/** Used quantity per modifier id, for remaining-stock checks at resolve time. */
export const modifierUsedQuantities = async (
  ids: number[],
): Promise<Map<number, number>> =>
  new Map(
    (
      await readRows(
        from(tables.modifier_usages)
          .where({ modifier_id: ids })
          .groupBy((usage) => [usage.modifier_id])
          .select((usage) => ({
            modifier_id: usage.modifier_id,
            used: orZero(sum(usage.quantity)),
          })),
      )
    ).map((row) => [row.modifier_id, Number(row.used)]),
  );

/**
 * SQL predicate that holds while a modifier has at least `usage.quantity` units
 * left (unlimited when its stock is null). The single source of truth for "is
 * this modifier in stock", shared by the guarded usage insert (its own
 * concurrency guard) and by the booking insert that must refuse to land when a
 * chosen modifier sold out mid-payment. Wrapped in parens so several can be
 * AND-ed safely. */
const modifierStockCondition = ({
  modifierId,
  quantity,
}: ModifierUsage): SqlStatement =>
  sql`((SELECT stock FROM modifiers WHERE id = ${modifierId}) IS NULL
           OR (SELECT stock FROM modifiers WHERE id = ${modifierId})
               - COALESCE(
                   (SELECT SUM(quantity) FROM modifier_usages WHERE modifier_id = ${modifierId}),
                   0
                  ) >= ${quantity})`;

/**
 * The AND of every chosen modifier's {@link modifierStockCondition}, for folding
 * into a booking insert's WHERE so the booking lands only when *all* its
 * modifiers still have stock. With no modifiers this is the always-true `1 = 1`,
 * so the booking's capacity clause stands alone. */
export const allModifiersInStockCondition = (
  usages: ModifierUsage[],
): SqlStatement =>
  usages.length === 0
    ? sql`1 = 1`
    : sqlJoin(usages.map(modifierStockCondition), sql` AND `);

/**
 * One guarded `modifier_usages` insert. `attendeeId` is the subquery that
 * finds the attendee row which the same batch inserts earlier. The row lands
 * only while `guard` holds. The batch writer performs its rollback check
 * immediately before these inserts, so no later compensating check is needed
 * here. */
export const usageInsert = (
  usage: ModifierUsage,
  attendeeId: SqlStatement,
  guard: SqlStatement,
): SqlStatement =>
  insertInto(
    tables.modifier_usages,
    {
      amount_applied: usage.amountApplied,
      attendee_id: valued<number>(attendeeId),
      created: nowIso(),
      modifier_id: usage.modifierId,
      quantity: usage.quantity,
    },
    { when: valued<boolean>(guard) },
  );

/**
 * Whether any of these modifiers no longer has stock for its quantity — the
 * post-failure probe that tells a booking that failed to land *why*: a sold-out
 * add-on/discount (this returns true) versus the event itself filling up. Read
 * only on the failure path, so it never weighs on a successful checkout. A
 * null-stock (unlimited) or unknown modifier is never the sold-out cause. */
export const anyModifierSoldOut = async (
  usages: ModifierUsage[],
): Promise<boolean> => {
  if (usages.length === 0) return false;
  const row = await queryOnePrimary<{ sold_out: number }>(
    sql`SELECT EXISTS (
       SELECT 1
       FROM json_each(${JSON.stringify(usages)}) AS requestedUsage
       JOIN modifiers AS modifier
         ON modifier.id = json_extract(requestedUsage.value, '$.modifierId')
       WHERE modifier.stock IS NOT NULL
         AND modifier.stock - COALESCE((
           SELECT SUM(storedUsage.quantity)
           FROM modifier_usages AS storedUsage
           WHERE storedUsage.modifier_id = modifier.id
         ), 0) < CAST(json_extract(requestedUsage.value, '$.quantity') AS INTEGER)
     ) AS sold_out`,
  );
  return Number(row!.sold_out) === 1;
};
