import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { renderFilteredValue } from "#shared/tables/liquid.ts";
import type { TableCellRenderer } from "#templates/components/table.tsx";

/** Apply saved Liquid filters only to columns that expose a raw value. */
export const filteredTableCells =
  <TRow, TContext>(
    filters: ReadonlyMap<string, string>,
  ): TableCellRenderer<TRow, TContext> =>
  (
    column: TableColumn<TRow, TContext>,
    row: TRow,
    context: TContext,
    index: number,
    rows: readonly TRow[],
  ): Child => {
    const expression = filters.get(column.key);
    return expression !== undefined && column.rawValue !== undefined
      ? renderFilteredValue(
          expression,
          column.rawValue(row, context),
          column.key,
        )
      : column.cell(row, context, index, rows);
  };
