import { t } from "#i18n";
import type { TableColumn } from "#shared/tables/column.ts";

/** Read one translated table heading in the active request. */
export const translatedTableHeader =
  (key: string): (() => string) =>
  () =>
    t(key);

/** Build a keyed table column whose header is translated when rendered. */
export const translatedTableColumn = <
  TRow,
  const TKey extends string,
  TContext = undefined,
>(
  key: TKey,
  headerKey: string,
  cell: TableColumn<TRow, TContext, TKey>["cell"],
): TableColumn<TRow, TContext, TKey> => ({
  cell,
  header: translatedTableHeader(headerKey),
  key,
});
