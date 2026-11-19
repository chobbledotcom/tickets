import { it as test } from "@std/testing/bdd";

/** Named rows of a case table: each key names the case, and its value holds
 *  the row's fields in the order the caller reads them. */
export type CaseTable = Readonly<Record<string, readonly string[]>>;

/** Records from a case table, with `fields` naming each value in row order. */
export const caseRecords = <K extends string>(
  fields: readonly K[],
  cases: CaseTable,
): Record<K, string>[] =>
  Object.values(cases).map((values) => {
    const record = {} as Record<K, string>;
    for (const [index, field] of fields.entries()) {
      record[field] = values[index]!;
    }
    return record;
  });

/** One test per named case, handing the row's values to `body`. */
export const testCases = (
  cases: CaseTable,
  body: (...values: string[]) => void | Promise<void>,
): void => {
  for (const [name, values] of Object.entries(cases)) {
    test(name, () => body(...values));
  }
};
