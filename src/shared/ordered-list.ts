// effects: pure
/**
 * One ordered admin list, declared once. It says where each row's move
 * routes live, the key of each row, the page a move returns to, and the
 * message a move shows. The admin routes list, the move routes and the
 * reorder column all read it, so none of them can drift.
 *
 * Most rows go by their own id, in the last param of the row path. A row
 * path with two params belongs to a parent record, named by the first. Such
 * a list declares only its paths. Another list names its own key.
 */

import type { RouteParamsFor } from "#routes/router.ts";
import type { MovePlace } from "#shared/reorder.ts";
import { fillRoutePattern } from "#shared/route-pattern.ts";
import type { ReorderColumnOptions } from "#shared/tables/column.ts";

/** The route params of one row of a list. */
export type RowParams<RowPath extends string> = RouteParamsFor<RowPath>;

/** A row that goes by its own id. */
export type IdRow = { readonly id: number };

/** The parent record of a row path: the id in its first param when the path
 *  holds two, or none. */
export type ParentOf<RowPath extends string> =
  RowPath extends `${string}/:${string}/${string}/:${string}`
    ? number
    : undefined;

/** The two move writes of one ordered row, under the row's path. */
export type MoveWrites<Name extends string, RowPath extends string> = {
  readonly [Place in MovePlace as `${Name}Move${Capitalize<Place>}`]: `${RowPath}/move-${Place}`;
};

/** How a list's rows map to their routes, when not by their own id. */
type RowKey<RowPath extends string, Row, Key> = {
  /** The route params of one row, from the row and its parent record. */
  readonly paramsOf: (
    row: Row,
    parent: ParentOf<RowPath>,
  ) => RowParams<RowPath>;
  /** The key that a row goes by in the stored order. */
  readonly keyOf: (params: RowParams<RowPath>) => Key;
};

/** What a list declares about itself. */
type Declaration<Name extends string, RowPath extends string, Row, Key> = {
  /** The prefix of the list's two write ids. */
  readonly name: Name;
  /** The path of one row. Its two move routes hang off it. */
  readonly rowPath: RowPath;
  /** The path of the page that shows the list, filled from a row's params.
   *  A move returns to it. */
  readonly listPath: string;
  /** The catalog key of the message that a move shows. */
  readonly moved: string;
} & (Row extends IdRow
  ? Partial<RowKey<RowPath, Row, Key>>
  : RowKey<RowPath, Row, Key>);

/** One ordered list: its declaration and everything read off it. */
export type OrderedListSpec<
  Name extends string,
  RowPath extends string,
  Row,
  Key,
> = RowKey<RowPath, Row, Key> & {
  readonly name: Name;
  readonly rowPath: RowPath;
  readonly moved: string;
  /** The list's two writes, for the admin routes list. */
  readonly writes: MoveWrites<Name, RowPath>;
  /** The parent record a row's params name. */
  readonly parentOf: (params: RowParams<RowPath>) => ParentOf<RowPath>;
  /** The page that shows the list a row belongs to. */
  readonly listPathFor: (params: RowParams<RowPath>) => string;
  /** The drag handle and arrows of the list's table or cards. */
  readonly column: (
    ...parent: ParentOf<RowPath> extends undefined
      ? []
      : [parent: ParentOf<RowPath>]
  ) => ReorderColumnOptions<Row>;
};

const writesOf = <Name extends string, RowPath extends string>(
  name: Name,
  rowPath: RowPath,
): MoveWrites<Name, RowPath> =>
  ({
    [`${name}MoveAfter`]: `${rowPath}/move-after`,
    [`${name}MoveBefore`]: `${rowPath}/move-before`,
  }) as MoveWrites<Name, RowPath>;

/** The key and params of a row that goes by its own id. The row's id fills
 *  the last param, and the parent fills the first when there are two. */
const byOwnId = <RowPath extends string, Row, Key>(
  rowPath: RowPath,
): RowKey<RowPath, Row, Key> => {
  const names = [...rowPath.matchAll(/:(\w+)/g)].map((match) => match[1]!);
  const own = names[names.length - 1]!;
  const parent = names.length > 1 ? names[0]! : undefined;
  return {
    keyOf: (params) => (params as Record<string, unknown>)[own] as Key,
    paramsOf: (row, parentId) =>
      ({
        ...(parent === undefined ? {} : { [parent]: parentId }),
        [own]: (row as IdRow).id,
      }) as RowParams<RowPath>,
  };
};

export const orderedListSpec = <
  const Name extends string,
  const RowPath extends string,
  Row = IdRow,
  Key = number,
>(
  declaration: Declaration<Name, RowPath, Row, Key>,
): OrderedListSpec<Name, RowPath, Row, Key> => {
  const { listPath, moved, name, rowPath } = declaration;
  const fallback = byOwnId<RowPath, Row, Key>(rowPath);
  const keyOf = declaration.keyOf ?? fallback.keyOf;
  const paramsOf = declaration.paramsOf ?? fallback.paramsOf;
  const first = rowPath.match(/:(\w+)/)![1]!;
  const hasParent = rowPath.indexOf(":") !== rowPath.lastIndexOf(":");
  return {
    column: (...given) => {
      const parent = given[0] as ParentOf<RowPath>;
      return {
        anchor: (row) => String(keyOf(paramsOf(row, parent))),
        path: (row) => {
          const params: Record<string, unknown> = paramsOf(row, parent);
          return fillRoutePattern(rowPath, (name) => params[name]);
        },
      };
    },
    keyOf,
    listPathFor: (params) => {
      const values: Record<string, unknown> = params;
      return fillRoutePattern(listPath, (name) => values[name]);
    },
    moved,
    name,
    paramsOf,
    parentOf: (params) =>
      (hasParent
        ? (params as Record<string, unknown>)[first]
        : undefined) as ParentOf<RowPath>,
    rowPath,
    writes: writesOf(name, rowPath),
  };
};
