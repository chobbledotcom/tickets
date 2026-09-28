/** The staged copy of a checkout's free-text answers: sealed at rest, keyed by
 * the hash of the session id, taken back and deleted in the round trip the
 * completion reads, and replaced when the same checkout is created again. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import {
  stageCheckoutAnswers,
  takeCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { execute, queryOne } from "#db/client.ts";
import { runDatabasePruning } from "#db/prune.ts";
import { PRUNE_PAYMENTS_RETENTION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** The row's lookup key, the way the module itself computes it. */
const sessionIndexOf = (sessionId: string): Promise<string> =>
  hmacHash(sessionId);

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
      "SELECT sealed FROM checkout_pending_answers WHERE session_index = ?",
      [await sessionIndexOf("cs_sealed")],
    );
    expect(row).not.toBeNull();
    expect(row?.sealed).not.toContain("Coming by bus");
  });

  test("rests only the hash of the session id, never the id itself", async () => {
    await stageCheckoutAnswers("cs_reference", { "7": "text" });

    // For SumUp the session id is the checkout reference, which must never
    // rest in this database: the sumup_checkouts rows stay sealed without it.
    const row = await queryOne<{ session_index: string }>(
      "SELECT session_index FROM checkout_pending_answers WHERE session_index = ?",
      [await sessionIndexOf("cs_reference")],
    );
    expect(row).toEqual({
      session_index: await sessionIndexOf("cs_reference"),
    });
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

  test("prunes a row older than the payments clock and keeps a younger one", async () => {
    await stageCheckoutAnswers("cs_abandoned", { "7": "never paid" });
    await stageCheckoutAnswers("cs_open", { "7": "still open" });
    await execute(
      "UPDATE checkout_pending_answers SET created_at = ? WHERE session_index = ?",
      [
        new Date(nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000).toISOString(),
        await sessionIndexOf("cs_abandoned"),
      ],
    );

    await runDatabasePruning();

    expect(await takeCheckoutAnswers("cs_abandoned")).toEqual(new Map());
    expect(await takeCheckoutAnswers("cs_open")).toEqual(
      new Map([[7, "still open"]]),
    );
  });
});
