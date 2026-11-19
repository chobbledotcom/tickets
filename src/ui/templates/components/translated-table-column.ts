import { t } from "#i18n";
import { formatDateLabel } from "#shared/date-labels.ts";
import type { TableColumn } from "#shared/tables/column.ts";

/** Read one translated table heading in the active request. */
export const translatedTableHeader =
  (key: string): (() => string) =>
  () =>
    t(key);

/** Build a keyed table column whose header is translated when rendered.
 *  `extras` carries the optional column properties a plain heading does not
 *  need: the column kind `class`, free-form class names, and per-cell
 *  attributes. A column with those still has one declaration. */
export const translatedTableColumn = <
  TRow,
  const TKey extends string,
  TContext = undefined,
>(
  key: TKey,
  headerKey: string,
  cell: TableColumn<TRow, TContext, TKey>["cell"],
  extras: Omit<
    TableColumn<TRow, TContext, TKey>,
    "cell" | "header" | "key"
  > = {},
): TableColumn<TRow, TContext, TKey> => ({
  ...extras,
  cell,
  header: translatedTableHeader(headerKey),
  key,
});

/** A keyed table column that shows one ISO date as the label a person reads. */
export const dateLabelColumn = <Row, TContext = undefined>(
  key: string,
  headerKey: string,
  date: (row: Row) => string,
): TableColumn<Row, TContext> =>
  translatedTableColumn<Row, string, TContext>(key, headerKey, (row) =>
    formatDateLabel(date(row).slice(0, 10)),
  );

/** A keyed table column that names one value through its copy key, such as a
 *  status read from an exhaustive label record. */
export const labelColumn = <Row, Value extends string>(
  key: string,
  headerKey: string,
  labelKeys: Readonly<Record<Value, string>>,
  value: (row: Row) => Value,
): TableColumn<Row> =>
  translatedTableColumn<Row, string>(key, headerKey, (row) =>
    t(labelKeys[value(row)]),
  );
