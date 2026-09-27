/** The staged copy of a checkout's free-text answers: sealed at rest, taken
 * back and deleted in the round trip the completion reads, and replaced when
 * the same checkout is created again. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  stageCheckoutAnswers,
  takeCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { queryOne } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

describeWithEnv("checkout pending answers", { db: true }, () => {
  test("stages sealed rows and gives them back by session id", async () => {
    await stageCheckoutAnswers("cs_staged", { "7": "Coming by bus" });

    expect(await takeCheckoutAnswers("cs_staged")).toEqual(
      new Map([[7, "Coming by bus"]]),
    );
  });

  test("rests the text sealed, not as plaintext", async () => {
    await stageCheckoutAnswers("cs_sealed", { "7": "Coming by bus" });

    const row = await queryOne<{ sealed: string }>(
      "SELECT sealed FROM checkout_pending_answers WHERE session_id = ?",
      ["cs_sealed"],
    );
    expect(row?.sealed).not.toContain("Coming by bus");
  });

  test("takes the row away, so a second take finds nothing", async () => {
    await stageCheckoutAnswers("cs_taken", { "7": "Once only" });

    expect(await takeCheckoutAnswers("cs_taken")).toEqual(
      new Map([[7, "Once only"]]),
    );
    expect(await takeCheckoutAnswers("cs_taken")).toEqual(new Map());
  });

  test("replaces what an earlier session id staged, and skips empty answers", async () => {
    await stageCheckoutAnswers("cs_replaced", { "7": "first try" });
    await stageCheckoutAnswers("cs_replaced", { "8": "second try" });
    await stageCheckoutAnswers("cs_empty", undefined);

    expect(await takeCheckoutAnswers("cs_replaced")).toEqual(
      new Map([[8, "second try"]]),
    );
    expect(await takeCheckoutAnswers("cs_empty")).toEqual(new Map());
  });

  test("spends one database call to take a row", async () => {
    await stageCheckoutAnswers("cs_one_call", { "7": "count me" });

    const calls = await countDatabaseCalls(1, () =>
      takeCheckoutAnswers("cs_one_call"),
    );

    expect(calls).toBe(1);
  });
});
