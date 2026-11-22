/**
 * The two move routes of one ordered list, built from its declaration. Each
 * route moves its row to just before or just after the row the `anchor`
 * field names. The arrows name the next row up or down, and a drop names the
 * row it lands next to. A row or a parent that is gone answers 404. An
 * anchor that is gone, or is the row itself, changes nothing. A `returnUrl`
 * field brings the operator back to the filtered page.
 */

import type { OrderedCollection } from "#db/ordered-collection.ts";
import { requiredMapValue } from "#fp";
import { t } from "#i18n";
import { formPolicyFor } from "#routes/auth.ts";
import { notFoundResponse, redirect } from "#routes/response.ts";
import { adminDestinationAt } from "#shared/admin-surface.ts";
import { authedHandlerWithStep } from "#shared/app-forms.ts";
import type {
  IdRow,
  OrderedListSpec,
  ParentOf,
  RowParams,
} from "#shared/ordered-list.ts";
import { type MovePlace, moveKey } from "#shared/reorder.ts";
import type { ParamsRoute } from "#shared/response-steps.ts";

/** The order of a list whose rows go by their id. A list under a parent
 *  record stores its rows under that parent. */
type OrderOf<RowPath extends string> =
  ParentOf<RowPath> extends number
    ? OrderedCollection<"id", string>
    : OrderedCollection<"id", undefined>;

/** Store the rows of one parent in this new order. */
type Arrange<RowPath extends string, Row> = (
  rows: readonly Row[],
  parent: ParentOf<RowPath>,
) => Promise<void>;

/** How one list stores its order: in the ordered collection of its ids, or
 *  by its own step. */
type Storage<RowPath extends string, Row> = Row extends IdRow
  ?
      | { readonly order: OrderOf<RowPath> }
      | { readonly arrange: Arrange<RowPath, Row> }
  : { readonly arrange: Arrange<RowPath, Row> };

/** How one list reads and stores its order. */
export type OrderedListStore<RowPath extends string, Row> = {
  /** The rows under one parent, in their stored order. Null when the parent
   *  is gone. */
  readonly rows: (
    parent: ParentOf<RowPath>,
  ) => readonly Row[] | null | Promise<readonly Row[] | null>;
} & Storage<RowPath, Row>;

/** The two move routes, keyed as the route table keys them. */
export type OrderedListRoutes<RowPath extends string> = Record<
  `POST ${RowPath}/move-${MovePlace}`,
  ParamsRoute<RowParams<RowPath>>
>;

/** The step that stores a new order. A collection of ids stores the ids,
 *  under the parent when the list has one. */
const arrangeStep = <RowPath extends string, Row>(
  storage: Storage<RowPath, Row>,
): Arrange<RowPath, Row> => {
  if ("arrange" in storage) return storage.arrange;
  const { order } = storage;
  const idsOf = (rows: readonly Row[]): number[] =>
    (rows as readonly IdRow[]).map((row) => row.id);
  return (rows, parent) =>
    parent === undefined
      ? (order as OrderedCollection<"id", undefined>).arrange({
          keys: idsOf(rows),
        })
      : (order as OrderedCollection<"id", string>).arrange({
          keys: idsOf(rows),
          scope: parent,
        });
};

/** The parts of a list's declaration that its move routes read. */
type MovedList<RowPath extends string, Row, Key> = Pick<
  OrderedListSpec<string, RowPath, Row, Key>,
  "keyOf" | "listPathFor" | "moved" | "paramsOf" | "parentOf" | "rowPath"
>;

export const orderedListRoutes = <RowPath extends string, Row, Key>(
  spec: MovedList<RowPath, Row, Key>,
  store: OrderedListStore<RowPath, Row>,
): OrderedListRoutes<RowPath> => {
  const auth = formPolicyFor(adminDestinationAt(`${spec.rowPath}/move-before`));
  const arrange = arrangeStep<RowPath, Row>(store);
  const move = (place: MovePlace): ParamsRoute<RowParams<RowPath>> =>
    authedHandlerWithStep<RowParams<RowPath>, undefined>(
      { auth },
      async ({ form, params }) => {
        const parent = spec.parentOf(params);
        const rows = (await store.rows(parent)) ?? [];
        const target = spec.keyOf(params);
        const rowByKey = new Map(
          rows.map((row) => [spec.keyOf(spec.paramsOf(row, parent)), row]),
        );
        if (!rowByKey.has(target)) return notFoundResponse();
        const keys = [...rowByKey.keys()];
        const anchorText = form.getString("anchor");
        const anchor = keys.find((key) => String(key) === anchorText);
        const order =
          anchor === undefined ? null : moveKey(keys, target, place, anchor);
        const back = { form };
        const listPath = spec.listPathFor(params);
        if (order === null) {
          return redirect(listPath, t("common.reorder_stale"), false, back);
        }
        await arrange(
          order.map((key) => requiredMapValue(rowByKey, key)),
          parent,
        );
        return redirect(listPath, t(spec.moved), true, back);
      },
    );
  return {
    [`POST ${spec.rowPath}/move-after`]: move("after"),
    [`POST ${spec.rowPath}/move-before`]: move("before"),
  } as OrderedListRoutes<RowPath>;
};

/** The rows of a list read as bare ids. */
export const idRows = async (
  ids: Promise<readonly number[]>,
): Promise<IdRow[]> => (await ids).map((id) => ({ id }));
