/**
 * Admin mutation handlers that also write an activity-log note naming the row
 * they touched. The confirmed-delete pages and the in-transaction create hooks
 * repeat this shape, so the two curries live here.
 */

import { logActivity } from "#db/activity-log.ts";
import type { TxScope } from "#db/client.ts";
import type { OrderedCollection } from "#db/ordered-collection.ts";

/** The confirmed-delete handler body: delete one row, then log the deletion. */
export const confirmDeleteWithLog =
  <Row extends { id: number }>(
    deleteOne: (id: number) => Promise<unknown>,
    label: string,
    nameOf: (row: Row) => string,
  ) =>
  async (row: Row): Promise<void> => {
    await deleteOne(row.id);
    await logActivity(`${label} '${nameOf(row)}' deleted`);
  };

/** The in-transaction create hook: append the new row to its ordered
 * collection, then log the creation with the same transaction. */
export const appendWithCreationLog =
  (order: OrderedCollection<"id", undefined>, label: string, name: string) =>
  async (transaction: TxScope, id: number): Promise<void> => {
    await order.append({ key: id, transaction });
    await logActivity(
      `${label} '${name}' created`,
      undefined,
      undefined,
      transaction,
    );
  };
