/**
 * The one side effect an ordered collection's create write shares. It appends
 * the new row to its collection inside the row write's transaction, so a row
 * never exists unplaced. An update leaves the order alone.
 */

import type { OrderedCollection } from "#db/ordered-collection.ts";
import type { CrudSideEffect } from "#shared/rest/crud-api-types.ts";
import { okResult, type Result } from "#shared/result.ts";

/** The create-time order append for one ordered collection. `validate`
 *  prepares "append" only when the write creates the row. `persist` then
 *  appends on the same transaction, so a failed append rolls the row back. */
export const appendOnCreate = <Input, FullRow>(
  order: Pick<OrderedCollection<"id", undefined>, "append">,
): CrudSideEffect<Input, FullRow, boolean, never> => ({
  persist: async (transaction, id, appendOrder) => {
    if (appendOrder) {
      await order.append({ key: id, transaction });
    }
  },
  validate: async (
    _input: Input,
    _body: Record<string, unknown>,
    existing: FullRow | null,
  ): Promise<Result<boolean>> => okResult(existing === null),
});
