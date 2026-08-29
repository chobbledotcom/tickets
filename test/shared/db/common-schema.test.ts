import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryOne } from "#db/client.ts";
import { aggregateRepairs, cachedEntityTable } from "#db/common-schema.ts";
import type { Answer } from "#db/question-types.ts";
import { answersTable } from "#db/questions/tables.ts";
import {
  getAllCacheStats,
  invalidateCachesForTable,
} from "#shared/cache-registry.ts";
import {
  addAnswer,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The answers table's own insert shape, which the module keeps private. */
type AnswerRow = Parameters<typeof answersTable.insert>[0];

type CachedRow = { id: number; key: string };

const ROWS: CachedRow[] = [
  { id: 1, key: "one" },
  { id: 2, key: "two" },
];

/** A cache over the real answers table, named uniquely so the registry entry
 * this leaves behind can never be mistaken for another test's. */
const cacheNamed = (name: string, dependsOn: readonly string[] = []) =>
  cachedEntityTable<Answer, AnswerRow, CachedRow>(
    name,
    answersTable,
    {
      fetchAll: () => Promise.resolve(ROWS),
      idOf: (row) => row.id,
      keyOf: (row) => row.key,
      ttlMs: 60_000,
    },
    dependsOn,
  );

const statNamed = (name: string) =>
  getAllCacheStats().find((stat) => stat.name === name);

describe("cachedEntityTable", () => {
  test("hands back the cache and the table it was given", async () => {
    const entity = cacheNamed("common-schema-test-returned");
    expect(entity.table).toBe(answersTable);
    expect(await entity.cache.getAll()).toEqual(ROWS);
  });

  test("reports the cache's live size to the stats registry under its name", async () => {
    const entity = cacheNamed("common-schema-test-stats");
    expect(statNamed("common-schema-test-stats")?.entries).toBe(0);
    await entity.cache.getAll();
    expect(statNamed("common-schema-test-stats")?.entries).toBe(ROWS.length);
  });

  test("clears the cache when its own table is written", async () => {
    const entity = cacheNamed("common-schema-test-own-table");
    await entity.cache.getAll();
    expect(entity.cache.size()).toBe(ROWS.length);
    invalidateCachesForTable(answersTable.name);
    expect(entity.cache.size()).toBe(0);
  });

  test("clears the cache when a table it depends on is written", async () => {
    const entity = cacheNamed("common-schema-test-dependency", ["listings"]);
    await entity.cache.getAll();
    invalidateCachesForTable("listings");
    expect(entity.cache.size()).toBe(0);
  });
});

describeWithEnv("aggregateRepairs", { db: true }, () => {
  const answerRepairs = aggregateRepairs<"times_selected">("answers", {
    // Bind the id, then ignore it: this proves the factory passes the caller's
    // own SQL through rather than knowing anything about answers.
    times_selected: "times_selected = COALESCE((SELECT 33 WHERE ? > 0), 0)",
  });

  const storedTotal = async (answerId: number): Promise<number | undefined> =>
    (
      await queryOne<{ times_selected: number }>(
        "SELECT times_selected FROM answers WHERE id = ?",
        [answerId],
      )
    )?.times_selected;

  const twoAnswers = async () => {
    const question = await createQuestion("Size?");
    return {
      first: await addAnswer(question.id, 0, "S"),
      second: await addAnswer(question.id, 1, "L"),
    };
  };

  test("update writes the values, and only on the named row", async () => {
    const { first, second } = await twoAnswers();
    await answerRepairs.update(first.id, { times_selected: 12 });
    expect(await storedTotal(first.id)).toBe(12);
    expect(await storedTotal(second.id)).toBe(0);
  });

  test("reset runs the caller's SQL against the named row", async () => {
    const { first, second } = await twoAnswers();
    await answerRepairs.update(first.id, { times_selected: 12 });
    await answerRepairs.reset(first.id, ["times_selected"]);
    expect(await storedTotal(first.id)).toBe(33);
    expect(await storedTotal(second.id)).toBe(0);
  });

  test("reset with no column named writes nothing", async () => {
    const { first } = await twoAnswers();
    await answerRepairs.update(first.id, { times_selected: 12 });
    await answerRepairs.reset(first.id, []);
    expect(await storedTotal(first.id)).toBe(12);
  });
});
