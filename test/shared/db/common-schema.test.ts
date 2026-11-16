import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#db/client.ts";
import { aggregateRepairs } from "#db/common-schema.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import {
  addAnswer,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("aggregateRepairs", { db: true }, () => {
  const answerRepairs = aggregateRepairs(tables.answers, {
    // Read the row's id, then ignore it: this proves the factory passes the
    // caller's own SQL through rather than knowing anything about answers.
    timesSelected: sql`COALESCE((SELECT 33 WHERE answers.id > 0), 0)`,
  });

  const storedTotal = async (answerId: number): Promise<number | undefined> =>
    (
      await queryOne<{ times_selected: number }>(
        sql`SELECT times_selected FROM answers WHERE id = ${answerId}`,
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
    await answerRepairs.update(first.id, { timesSelected: 12 });
    expect(await storedTotal(first.id)).toBe(12);
    expect(await storedTotal(second.id)).toBe(0);
  });

  test("reset runs the caller's SQL against the named row", async () => {
    const { first, second } = await twoAnswers();
    await answerRepairs.update(first.id, { timesSelected: 12 });
    await answerRepairs.reset(first.id, ["timesSelected"]);
    expect(await storedTotal(first.id)).toBe(33);
    expect(await storedTotal(second.id)).toBe(0);
  });

  test("reset with no column named writes nothing", async () => {
    const { first } = await twoAnswers();
    await answerRepairs.update(first.id, { timesSelected: 12 });
    await answerRepairs.reset(first.id, []);
    expect(await storedTotal(first.id)).toBe(12);
  });
});
