/** Read ledger measures for each of a list of accounts, in one
 * statement. */

import {
  type AccountId,
  type Measure,
  measureOf,
} from "#accounting/projection-sql.ts";
import { queryAll } from "#db/client.ts";
import { type Counted, valued } from "#db/select/expression.ts";
import { sql, sqlCommas, sqlName, sqlRows } from "#db/sql.ts";
import { requiredMapValue } from "#fp";

/** Named measures, read together. */
export type Measures = Readonly<Record<string, Measure>>;

/** The value of each measure. A measure that can find no row reads null. */
export type MeasuresRow<Set extends Measures> = {
  [Name in keyof Set]: Set[Name] extends Measure<"largest">
    ? number | null
    : number;
};

type StoredRow = Record<string, Counted | null>;

/** SQLite can give a total back as a bigint. */
const asNumbers = <Set extends Measures>(row: StoredRow): MeasuresRow<Set> =>
  Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name,
      value === null ? null : Number(value),
    ]),
  ) as MeasuresRow<Set>;

/** The account id of each row of {@link readMeasuresByAccount}. */
const ACCOUNT_ID = valued<string>(sql`account.id`);

/** The measures of each of `ids`, keyed by id, in one statement. Each measure
 * reads only the rows of its own account, so an index backs it. Ledger ids
 * are text, so a numeric id and a named one such as "vat" both work. */
export const readMeasuresByAccount = async <
  Set extends Measures,
  Id extends number | string,
>(
  ids: readonly Id[],
  measuresFor: (id: AccountId) => Set,
): Promise<Map<Id, MeasuresRow<Set>>> => {
  if (ids.length === 0) return new Map();
  const measures = Object.entries(measuresFor(ACCOUNT_ID)).map(
    ([name, measure]) => sql`${measureOf(measure)} AS ${sqlName(name)}`,
  );
  const rows = await queryAll<StoredRow & { id: string }>(
    sql`WITH account(id) AS (VALUES ${sqlRows(ids.map((id) => [String(id)]))})
     SELECT account.id AS id, ${sqlCommas(measures)} FROM account`,
  );
  const idOfText = new Map(ids.map((id) => [String(id), id]));
  return new Map(
    rows.map(({ id, ...row }) => [
      requiredMapValue(idOfText, id),
      asNumbers<Set>(row),
    ]),
  );
};
