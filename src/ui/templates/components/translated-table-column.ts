import { t } from "#i18n";
import type { TableColumn } from "#shared/tables/column.ts";

/** Read one translated table heading in the active request. */
export const translatedTableHeader =
  (key: string): (() => string) =>
  () =>
    t(key);

/** Build a keyed table column whose header is translated when rendered. */
export const translatedTableColumn = <TRow, TContext = undefined>(
  key: string,
  headerKey: string,
  cell: TableColumn<TRow, TContext>["cell"],
): TableColumn<TRow, TContext> => ({
  cell,
  header: translatedTableHeader(headerKey),
  key,
});
