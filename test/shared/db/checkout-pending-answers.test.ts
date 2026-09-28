/** The staged copy of a checkout's answers: sealed under the independent
 * work key, keyed by the hash of the session id, read without consuming so a
 * receipt and due emails can commit first, and deleted only through an
 * explicit terminal or paid handoff. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setCheckoutWorkKeyForTest } from "#crypto/checkout-work.ts";
import { hmacHash } from "#crypto/hashing.ts";
import {
  deleteCheckoutAnswers,
  markCheckoutAnswersPaid,
  readCheckoutAnswers,
  stageCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { queryOne } from "#db/client.ts";
import type { SubmittedAnswers } from "#shared/email/answer-receipt.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { TEST_CHECKOUT_WORK_KEY } from "#test-utils/internal.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** The row's lookup key, the way the module itself computes it. */
const sessionIndexOf = (sessionId: string): Promise<string> =>
  hmacHash(sessionId);

const snapshotOf = (listingId: number): SubmittedAnswers => [
  {
    answers: [
      {
        kind: "free_text",
        question: "Anything else?",
        questionId: 7,
        text: "Coming by bus",
      },
    ],
    listingId,
  },
];

describeWithEnv("checkout pending answers", { db: true }, () => {
  test("stages sealed rows and reads them back by session id", async () => {
    await stageCheckoutAnswers("cs_staged", { "7": "Coming by bus" });

    expect(await readCheckoutAnswers("cs_staged")).toEqual({
      snapshot: [],
      texts: new Map([[7, "Coming by bus"]]),
    });
  });

  test("rests the text sealed, not as plaintext", async () => {
    await stageCheckoutAnswers("cs_sealed", { "7": "Coming by bus" });

    const row = await queryOne<{ sealed: string; wrapped_key: string }>(
      "SELECT sealed, wrapped_key FROM checkout_pending_answers WHERE session_index = ?",
      [await sessionIndexOf("cs_sealed")],
    );
    expect(row).not.toBeNull();
    expect(row?.sealed).not.toContain("Coming by bus");
  });

  test("cannot be opened with the database encryption key alone", async () => {
    await stageCheckoutAnswers("cs_work_key", { "7": "Coming by bus" });

    // A dump plus DB_ENCRYPTION_KEY must not read staged text: only the
    // independent work key unwraps the row key that opens the payload.
    setCheckoutWorkKeyForTest(null);
    try {
      expect(
        await readCheckoutAnswers("cs_work_key").catch(() => "refused"),
      ).toBe("refused");
    } finally {
      setCheckoutWorkKeyForTest(TEST_CHECKOUT_WORK_KEY);
    }
    expect((await readCheckoutAnswers("cs_work_key"))?.texts.get(7)).toBe(
      "Coming by bus",
    );
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

  test("a read does not consume the row; only the delete does", async () => {
    await stageCheckoutAnswers("cs_taken", { "7": "Once only" });
    expect((await readCheckoutAnswers("cs_taken"))?.texts.get(7)).toBe(
      "Once only",
    );
    expect((await readCheckoutAnswers("cs_taken"))?.texts.get(7)).toBe(
      "Once only",
    );

    await deleteCheckoutAnswers("cs_taken");
    expect(await readCheckoutAnswers("cs_taken")).toBeNull();
  });

  test("replaces what an earlier open row staged", async () => {
    await stageCheckoutAnswers("cs_replaced", { "7": "first try" });
    await stageCheckoutAnswers("cs_replaced", { "8": "second try" });

    expect((await readCheckoutAnswers("cs_replaced"))?.texts.get(8)).toBe(
      "second try",
    );
  });

  test("refuses to re-stage a checkout that left the open state", async () => {
    await stageCheckoutAnswers("cs_paid", { "7": "text" });
    expect(await markCheckoutAnswersPaid("cs_paid")).toBe(true);

    await expect(
      stageCheckoutAnswers("cs_paid", { "8": "different" }),
    ).rejects.toThrow("already being completed");
  });

  test("marking paid keeps the row for the receipt handoff", async () => {
    await stageCheckoutAnswers("cs_marked", { "7": "text" });

    expect(await markCheckoutAnswersPaid("cs_marked")).toBe(true);
    expect((await readCheckoutAnswers("cs_marked"))?.texts.get(7)).toBe("text");
    expect(await markCheckoutAnswersPaid("cs_missing")).toBe(false);
  });

  test("keeps the staged snapshot beside the texts", async () => {
    await stageCheckoutAnswers(
      "cs_snapshot",
      { "7": "Coming by bus" },
      snapshotOf(3),
    );

    expect(await readCheckoutAnswers("cs_snapshot")).toEqual({
      snapshot: snapshotOf(3),
      texts: new Map([[7, "Coming by bus"]]),
    });
  });

  test("requires a usable Square link id when one is given", async () => {
    await expect(stageCheckoutAnswers("cs_square", {}, [], "")).rejects.toThrow(
      "Square payment link ID is missing",
    );
  });

  test("spends one database call to read a row", async () => {
    await stageCheckoutAnswers("cs_one_call", { "7": "count me" });

    const calls = await countDatabaseCalls(1, () =>
      readCheckoutAnswers("cs_one_call"),
    );

    expect(calls).toBe(1);
  });
});
