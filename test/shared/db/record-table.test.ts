import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { execute, getDb, queryAll } from "#db/client.ts";
import {
  deleteRow,
  findRow,
  findRowPrimary,
  hasRow,
  insertRow,
  insertRowStatement,
  newRowValuesOf,
  rowValuesOf,
  updateRow,
  updateRowStatement,
} from "#db/record-table.ts";
import { equal } from "#db/select/expression.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";

/** Each stored agent name as the table holds it: sealed. */
const storedNames = (): Promise<{ id: number; name: EnvKeyEncrypted }[]> =>
  queryAll<{ id: number; name: EnvKeyEncrypted }>(
    sql`SELECT id, name FROM logistics_agents ORDER BY id`,
  );

/** Each stored agent with its name opened. */
const openedAgents = async (): Promise<{ id: number; name: string }[]> =>
  Promise.all(
    (await storedNames()).map(async ({ id, name }) => ({
      id,
      name: await decrypt(name),
    })),
  );

const addAgent = (name: string) => insertRow(tables.logistics_agents, { name });

describeWithEnv("db > record table", { db: true }, () => {
  test("insertRow seals each value and gives back the decoded row", async () => {
    const row = await addAgent("Van one");

    expect(row).toEqual({ id: 1, name: "Van one" });
    const [stored] = await storedNames();
    expect(stored?.name).not.toBe("Van one");
    expect(await openedAgents()).toEqual([{ id: 1, name: "Van one" }]);
  });

  // The id comes back from the row that the INSERT wrote, so it needs no
  // help from the optional lastInsertRowid, which some drivers leave out.
  test("insertRow takes the id from the row that the insert gave back", async () => {
    await addAgent("First");
    const realExecute = getDb().execute.bind(getDb());
    using _execute = stub(getDb(), "execute", async (...args) => {
      const result = await realExecute(
        ...(args as Parameters<typeof realExecute>),
      );
      return { ...result, lastInsertRowid: undefined };
    });

    expect(await addAgent("Second")).toEqual({ id: 2, name: "Second" });
  });

  test("insertRow throws when the insert gives back no row", async () => {
    using _execute = stub(getDb(), "execute", () =>
      Promise.resolve(emptyResultSet()),
    );

    await expect(addAgent("Nameless")).rejects.toThrow(
      "The insert into logistics_agents gave back no row",
    );
  });

  test("an insert statement with a false condition writes no row", async () => {
    const result = await execute(
      await insertRowStatement(
        tables.logistics_agents,
        { name: "Skipped" },
        { when: false },
      ),
    );

    expect(result.rows).toEqual([]);
    expect(await storedNames()).toEqual([]);
  });

  test("updateRow seals the change and gives back the decoded row", async () => {
    const first = await addAgent("Before");
    const other = await addAgent("Other");

    expect(
      await updateRow(tables.logistics_agents, first.id, { name: "After" }),
    ).toEqual({ id: first.id, name: "After" });
    expect(await openedAgents()).toEqual([
      { id: first.id, name: "After" },
      { id: other.id, name: "Other" },
    ]);
  });

  test("updateRow gives null when no row has the id", async () => {
    expect(
      await updateRow(tables.logistics_agents, 99, { name: "Ghost" }),
    ).toBeNull();
  });

  test("updateRow with no named change reads the row as it is", async () => {
    const row = await addAgent("Kept");

    expect(await updateRow(tables.logistics_agents, row.id, {})).toEqual(row);
    expect(await openedAgents()).toEqual([row]);
  });

  test("an update statement with a false guard changes no row", async () => {
    const row = await addAgent("Guarded");
    const result = await execute(
      await updateRowStatement(
        tables.logistics_agents,
        row.id,
        { name: "Changed" },
        (agent) => equal(agent.id, 0),
      ),
    );

    expect(result.rows).toEqual([]);
    expect(await openedAgents()).toEqual([{ id: row.id, name: "Guarded" }]);
  });

  test("findRow and findRowPrimary give the decoded row, or null", async () => {
    const row = await addAgent("Found");

    expect(await findRow(tables.logistics_agents, row.id)).toEqual(row);
    expect(await findRowPrimary(tables.logistics_agents, row.id)).toEqual(row);
    expect(await findRow(tables.logistics_agents, row.id + 1)).toBeNull();
    expect(
      await findRowPrimary(tables.logistics_agents, row.id + 1),
    ).toBeNull();
  });

  test("hasRow tells whether a row has the id", async () => {
    const row = await addAgent("Here");

    expect(await hasRow(tables.logistics_agents, row.id)).toBe(true);
    expect(await hasRow(tables.logistics_agents, row.id + 1)).toBe(false);
  });

  test("deleteRow removes only the row with the id", async () => {
    const gone = await addAgent("Gone");
    const kept = await addAgent("Kept");

    await deleteRow(tables.logistics_agents, gone.id);

    expect(await openedAgents()).toEqual([{ id: kept.id, name: "Kept" }]);
  });
});

describe("db > record table > values from an input", () => {
  test("rowValuesOf takes each camelCase key that names a column", () => {
    expect(
      rowValuesOf(tables.holidays, {
        endDate: "2026-01-02",
        name: "New year",
        notAColumn: "dropped",
        startDate: undefined,
      }),
    ).toEqual({ end_date: "2026-01-02", name: "New year" });
  });

  test("newRowValuesOf adds the created time where the table has it", () => {
    const values = newRowValuesOf(tables.news_posts, { name: "Post" });

    expect(Object.keys(values).sort()).toEqual(["created", "name"]);
    expect(Number.isNaN(Date.parse(String(values.created)))).toBe(false);
  });

  test("newRowValuesOf puts the field defaults under the input values", () => {
    expect(
      newRowValuesOf(tables.holidays, { name: "Given" }, [
        { default: "Default name", key: "name", kind: "price" },
        { default: 3, key: "end_date", kind: "count" },
      ]),
    ).toEqual({ end_date: 3, name: "Given" });
  });
});
