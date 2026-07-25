import { once } from "#fp";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { createBaseLiquidEngine } from "#shared/liquid-engine.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import type { TableCellRenderer } from "#templates/components/table.tsx";

const getEngine = once(createBaseLiquidEngine);
const FIRST_FILTER_IS_DATE_RE = /^[^|]*\|\s*date\b/;

/** Render a raw value through its saved Liquid expression. A valid date string
 * becomes a Date only when `date` is the first filter in the chain. */
const renderFilteredValue = (
  expression: string,
  rawValue: unknown,
  key: string,
): string => {
  let contextValue = rawValue;
  if (
    typeof rawValue === "string" &&
    FIRST_FILTER_IS_DATE_RE.test(expression)
  ) {
    const date = new Date(rawValue);
    if (!Number.isNaN(date.getTime())) contextValue = date;
  }
  return getEngine()
    .parseAndRenderSync(`{{ ${expression} }}`, { [key]: contextValue })
    .trim();
};

/** Apply saved Liquid filters only to columns that expose a raw value. */
export const filteredTableCells =
  <TRow, TContext, TKey extends string>(
    filters: ReadonlyMap<TKey, string>,
  ): TableCellRenderer<TRow, TContext, TKey> =>
  (
    column: TableColumn<TRow, TContext, TKey>,
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
