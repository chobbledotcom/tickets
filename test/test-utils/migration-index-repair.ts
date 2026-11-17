import { expect } from "@std/expect";
import { getDb } from "#db/client.ts";
import { sql, sqlName } from "#db/sql.ts";
import { indexExists } from "#test-utils/migrations.ts";

/**
 * Drop a declared index, prove it is gone, then run the repair step and prove
 * the step put it back. A sync or migration that owns an index repairs it only
 * once a test drifts it away first.
 */
export const expectIndexRepaired = async (
  name: string,
  repair: () => Promise<void>,
): Promise<void> => {
  await getDb().execute(sql`DROP INDEX IF EXISTS ${sqlName(name)}`);
  expect(await indexExists(name)).toBe(false);

  await repair();

  expect(await indexExists(name)).toBe(true);
};
