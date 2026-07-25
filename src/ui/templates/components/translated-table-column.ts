import { t } from "#i18n";
import type { TableColumn } from "#shared/tables/definition.ts";

/** Build a keyed table column whose header is translated when rendered. */
export const translatedTableColumn = <TRow, TContext = void>(
  key: string,
  headerKey: string,
  cell: TableColumn<TRow, TContext>["cell"],
): TableColumn<TRow, TContext> => ({
  cell,
  header: () => t(headerKey),
  key,
});
