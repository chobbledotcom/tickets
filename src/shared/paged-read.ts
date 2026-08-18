import { range } from "#fp";

/** One page of a paged read: its rows, and whether more pages follow. */
export interface PagedRows<Row> {
  hasNext: boolean;
  rows: Row[];
}

/**
 * Read every row from a paged reader, one page at a time, until a page says
 * nothing follows. `maxPages` is the walk's hard stop: a reader still
 * reporting more pages past it has a page cursor that stopped advancing, so
 * this throws rather than reading forever.
 */
export const readAllPages = async <Row>(
  maxPages: number,
  readPage: (page: number) => Promise<PagedRows<Row>>,
): Promise<Row[]> => {
  const out: Row[] = [];
  for (const page of range(0, maxPages)) {
    const result = await readPage(page);
    for (const row of result.rows) out.push(row);
    if (!result.hasNext) return out;
  }
  throw new Error(
    `Paged read still reported more rows after ${maxPages} pages`,
  );
};
