import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { execute, getDb, queryAll, withTransaction } from "#db/client.ts";

import {
  existsOn,
  newRecordOf,
  records,
  rowValuesOf,
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

const addAgent = (name: string) => records.logistics_agents.insert({ name });

describeWithEnv("db > record table", { db: true }, () => {
  test("insert seals each value and gives back the decoded row", async () => {
    const row = await addAgent("Van one");

    expect(row).toEqual({ id: 1, name: "Van one" });
    const [stored] = await storedNames();
    expect(stored?.name).not.toBe("Van one");
    expect(await openedAgents()).toEqual([{ id: 1, name: "Van one" }]);
  });

  // The id comes back from the row that the INSERT wrote, so it needs no
  // help from the optional lastInsertRowid, which some drivers leave out.
  test("insert takes the id from the row that the insert gave back", async () => {
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

  test("insert throws when the insert gives back no row", async () => {
    using _execute = stub(getDb(), "execute", () =>
      Promise.resolve(emptyResultSet()),
    );

    await expect(addAgent("Nameless")).rejects.toThrow(
      "The insert into logistics_agents gave back no row",
    );
  });

  test("an insert statement with a false condition writes no row", async () => {
    const result = await execute(
      await records.logistics_agents.insertStatement(
        { name: "Skipped" },
        { when: false },
      ),
    );

    expect(result.rows).toEqual([]);
    expect(await storedNames()).toEqual([]);
  });

  test("update seals the change and gives back the decoded row", async () => {
    const first = await addAgent("Before");
    const other = await addAgent("Other");

    expect(
      await records.logistics_agents.update(first.id, { name: "After" }),
    ).toEqual({ id: first.id, name: "After" });
    expect(await openedAgents()).toEqual([
      { id: first.id, name: "After" },
      { id: other.id, name: "Other" },
    ]);
  });

  test("update gives null when no row has the id", async () => {
    expect(
      await records.logistics_agents.update(99, { name: "Ghost" }),
    ).toBeNull();
  });

  test("update with no named change reads the row as it is", async () => {
    const row = await addAgent("Kept");

    expect(await records.logistics_agents.update(row.id, {})).toEqual(row);
    expect(await openedAgents()).toEqual([row]);
  });

  test("an update statement with a false guard changes no row", async () => {
    const row = await addAgent("Guarded");
    const result = await execute(
      await records.logistics_agents.updateStatement(
        row.id,
        { name: "Changed" },
        (agent) => equal(agent.id, 0),
      ),
    );

    expect(result.rows).toEqual([]);
    expect(await openedAgents()).toEqual([{ id: row.id, name: "Guarded" }]);
  });

  test("find and findPrimary give the decoded row, or null", async () => {
    const row = await addAgent("Found");

    expect(await records.logistics_agents.find(row.id)).toEqual(row);
    expect(await records.logistics_agents.findPrimary(row.id)).toEqual(row);
    expect(await records.logistics_agents.find(row.id + 1)).toBeNull();
    expect(await records.logistics_agents.findPrimary(row.id + 1)).toBeNull();
  });

  test("has tells whether a row has the id", async () => {
    const row = await addAgent("Here");

    expect(await records.logistics_agents.has(row.id)).toBe(true);
    expect(await records.logistics_agents.has(row.id + 1)).toBe(false);
  });

  test("existsOn tells whether a read on an open transaction has a row", async () => {
    const row = await addAgent("Here");

    expect(
      await withTransaction(async (tx) => [
        await existsOn(tx, records.logistics_agents.byId(row.id)),
        await existsOn(tx, records.logistics_agents.byId(row.id + 1)),
      ]),
    ).toEqual([true, false]);
  });

  test("delete removes only the row with the id", async () => {
    const gone = await addAgent("Gone");
    const kept = await addAgent("Kept");

    await records.logistics_agents.delete(gone.id);

    expect(await openedAgents()).toEqual([{ id: kept.id, name: "Kept" }]);
  });
});

describe("db > record table > values from an input", () => {
  test("rowValuesOf takes each key that is a field of the table", () => {
    expect(
      rowValuesOf(tables.holidays, {
        endDate: "2026-01-02",
        name: "New year",
        notAColumn: "dropped",
        startDate: undefined,
      }),
    ).toEqual({ endDate: "2026-01-02", name: "New year" });
  });

  test("newRecordOf adds the created time where the table has it", () => {
    const values = newRecordOf(tables.news_posts)({ name: "Post" });

    expect(Object.keys(values).sort()).toEqual(["created", "name"]);
    expect(Number.isNaN(Date.parse(String(values.created)))).toBe(false);
  });

  test("newRecordOf puts the field defaults, by field, under the input values", () => {
    expect(
      newRecordOf(tables.holidays, [
        { default: "Default name", key: "name", kind: "price" },
        { default: 3, key: "endDate", kind: "count" },
      ])({ name: "Given" }),
    ).toEqual({ endDate: 3, name: "Given" });
  });
});
