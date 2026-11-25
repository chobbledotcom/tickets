/** Read ledger measures for the whole ledger or for each account. A read of
 * a set makes one pass over the rows that any of its measures reads. */

import {
  type AccountId,
  foldOf,
  ledgerLegs,
  type Measure,
  measureOf,
  some,
} from "#accounting/projection-sql.ts";
import {
  emptyRange,
  type LedgerRange,
  occurredAtRange,
} from "#accounting/range.ts";
import { queryAll, requireOne } from "#db/client.ts";
import { type Counted, valued } from "#db/select/expression.ts";
import {
  type RowsStatement,
  sql,
  sqlCommas,
  sqlName,
  sqlRows,
} from "#db/sql.ts";

/** Named measures, read together. */
export type Measures = Readonly<Record<string, Measure>>;

/** The value of each measure. A measure that can find no row reads null. */
export type MeasuresRow<Set extends Measures> = {
  [Name in keyof Set]: Set[Name] extends Measure<"largest">
    ? number | null
    : number;
};

type StoredRow = Record<string, Counted | null>;

/** One read of every measure in `set`, over the rows inside `range`. */
const measuresStatement = (
  set: Measures,
  range: LedgerRange,
): RowsStatement<StoredRow> => {
  const measures = Object.values(set);
  return ledgerLegs()
    .where((leg) => [
      some(...measures.map((measure) => measure.rows))(leg),
      ...occurredAtRange(range, leg),
    ])
    .select((leg) =>
      Object.fromEntries(
        Object.entries(set).map(([name, measure]) => [
          name,
          foldOf(measure, leg, false),
        ]),
      ),
    ) as RowsStatement<StoredRow>;
};

/** SQLite can give a total back as a bigint. */
const asNumbers = <Set extends Measures>(row: StoredRow): MeasuresRow<Set> =>
  Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name,
      value === null ? null : Number(value),
    ]),
  ) as MeasuresRow<Set>;

/** Every measure of `set` over the rows inside `range`, by default the whole
 * ledger. An aggregate read always gives one row. */
export const readMeasures = async <Set extends Measures>(
  set: Set,
  range: LedgerRange = emptyRange,
): Promise<MeasuresRow<Set>> =>
  asNumbers<Set>(await requireOne(measuresStatement(set, range)));

/** The account id of each row of {@link readMeasuresByAccount}. */
const ACCOUNT_ID = valued<string>(sql`account.id`);

/** The measures of each of `ids`, keyed by id, in one statement. Each measure
 * reads only the rows of its own account, so an index backs it. */
export const readMeasuresByAccount = async <Set extends Measures>(
  ids: readonly number[],
  measuresFor: (id: AccountId) => Set,
): Promise<Map<number, MeasuresRow<Set>>> => {
  if (ids.length === 0) return new Map();
  const measures = Object.entries(measuresFor(ACCOUNT_ID)).map(
    ([name, measure]) => sql`${measureOf(measure)} AS ${sqlName(name)}`,
  );
  const rows = await queryAll<StoredRow & { id: string }>(
    sql`WITH account(id) AS (VALUES ${sqlRows(ids.map((id) => [String(id)]))})
     SELECT account.id AS id, ${sqlCommas(measures)} FROM account`,
  );
  return new Map(
    rows.map(({ id, ...row }) => [Number(id), asNumbers<Set>(row)]),
  );
};
