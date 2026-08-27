import type { Child } from "#jsx/jsx-runtime.ts";

/**
 * A link to one row's own page, showing what the row is called. Every admin
 * collection names its rows this way, so a table only says where the row
 * lives and what to call it. A row that is switched off dims its own link
 * through `classOf`.
 */
export const linkCell =
  <TRow,>(
    pathOf: (row: TRow) => string,
    labelOf: (row: TRow) => Child,
    classOf?: (row: TRow) => string | undefined,
  ): ((row: TRow) => JSX.Element) =>
  (row) => (
    <a class={classOf?.(row)} href={pathOf(row)}>
      {labelOf(row)}
    </a>
  );
