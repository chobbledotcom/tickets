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
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import {
  executeBatchWithResults,
  getDb,
  inPlaceholders,
  queryAll,
} from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import { modifierDelta } from "#shared/price-modifier.ts";

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
): Promise<Map<number, number>> => {
  if (ids.length === 0) return new Map();
  const rows = await queryAll<{ modifier_id: number; used: number }>(
    `SELECT modifier_id, COALESCE(SUM(quantity), 0) AS used
     FROM modifier_usages WHERE modifier_id IN (${inPlaceholders(ids)})
     GROUP BY modifier_id`,
    ids,
  );
  return new Map(rows.map((r) => [r.modifier_id, r.used]));
};

/** Insert a usage row only while the modifier's remaining stock allows it
 * (unlimited when stock is null). Atomic, so it is also the concurrency guard. */
const guardedUsageInsert = (
  attendeeId: number,
  usage: ModifierUsage,
): { sql: string; args: InValue[] } => ({
  args: [
    usage.modifierId,
    attendeeId,
    usage.quantity,
    usage.amountApplied,
    nowIso(),
    usage.modifierId,
    usage.modifierId,
    usage.modifierId,
    usage.quantity,
  ],
  sql: `INSERT INTO modifier_usages
          (modifier_id, attendee_id, quantity, amount_applied, created)
        SELECT ?, ?, ?, ?, ?
        WHERE (SELECT stock FROM modifiers WHERE id = ?) IS NULL
           OR (SELECT stock FROM modifiers WHERE id = ?)
              - COALESCE(
                  (SELECT SUM(quantity) FROM modifier_usages WHERE modifier_id = ?),
                  0
                ) >= ?`,
});

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
  await getDb().execute({
    args: [attendeeId],
    sql: "DELETE FROM modifier_usages WHERE attendee_id = ?",
  });
  return false;
};

/**
 * Consume stock for a checkout's resolved modifiers and roll back the order
 * when a stock-limited modifier sold out between resolution and consumption.
 *
 * Returns true when every usage was recorded. Returns false after deleting the
 * newly-created attendee (and the partial `modifier_usages` rows it would have
 * owned) when consumption failed — so the caller only has to surface the
 * failure; the partially-created order is gone as if it never happened.
 *
 * `fullTotal` is the pre-modifier item subtotal the deltas are computed
 * against — the same base `priceCheckout` uses — so the recorded
 * `amount_applied` matches what the pricing engine charged. With no specs to
 * apply this is a no-op (the caller may have resolved nothing for a cart with
 * no eligible modifiers).
 */
export const consumeModifierStockOrRollback = async (
  attendeeId: number,
  specs: ModifierSpec[],
  fullTotal: number,
): Promise<boolean> => {
  if (specs.length === 0) return true;
  const consumed = await consumeModifierStock(
    attendeeId,
    specs.map((s) => ({
      amountApplied: Math.abs(modifierDelta(fullTotal, s.kind, s.value)),
      modifierId: s.id,
      quantity: s.quantity,
    })),
  );
  if (consumed) return true;
  await deleteAttendee(attendeeId);
  return false;
};
