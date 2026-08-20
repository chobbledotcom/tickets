import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { paymentCaseDecisionTable } from "#db/migrations/schema/payments/decisions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectAccepted,
  expectRefused,
  expectRefusedAsRepeat,
} from "./refuses.ts";

const aDecision = (values: string) =>
  `INSERT INTO payment_case_decisions
    (case_id, case_revision, claim, state, attempt_count, created_at)
    VALUES (${values})`;

test("is what the owner's decision is made of", () => {
  const [name, table] = paymentCaseDecisionTable;

  expect(name).toBe("payment_case_decisions");
  expect(table.columns.map(([held]) => held)).toEqual([
    "id",
    "case_id",
    "case_revision",
    "claim",
    "decision",
    "state",
    "attempt_count",
    "created_at",
    "last_attempt_at",
    "next_retry_at",
    "last_error",
  ]);
});

describeWithEnv("db > payment decision and message rules", { db: true }, () => {
  // What the owner was looking at, what was decided, and what went wrong are
  // all allowed to be missing — but never held in the open.
  for (const [name, claim, decision, lastError] of [
    ["what the owner was looking at", "'Give it back'", "NULL", "NULL"],
    ["what was decided", "'enc:1:a:b'", "'Refunded'", "NULL"],
    ["what went wrong", "'enc:1:a:b'", "NULL", "'Card declined'"],
  ] as const) {
    test(`refuses a decision keeping ${name} in plain words`, async () => {
      await expectRefused(`INSERT INTO payment_case_decisions
        (case_id, case_revision, claim, state, attempt_count, created_at,
         decision, last_error)
        VALUES (1, 1, ${claim}, 'accepted', 0, 0, ${decision}, ${lastError})`);
    });
  }

  test("accepts a decision taken but not yet carried out", () => {
    // What was decided and what went wrong are both allowed to be missing, so
    // the rules on them have to let a missing one through as well as turning
    // a plain one away. Only the claim itself must always be there.
    return expectAccepted(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, attempt_count, created_at,
       decision, last_error)
      VALUES (99, 1, 'enc:1:a:b', 'accepted', 0, 0, NULL, NULL)`);
  });

  // The buyer's name, email, phone and address wait here until the message
  // goes out, so this column may never hold them in the open.
  for (const [name, data] of [
    ["in plain words", "Dear Buyer"],
    ["behind an envelope with nothing in it", "enc:1:Dear Buyer"],
  ] as const) {
    test(`refuses a message to send held ${name}`, async () => {
      await expectRefused(`INSERT INTO payment_completion_deliveries
        (payment_id, delivery_key, data)
        VALUES ('plain-message', 'registration_email', '${data}')`);
    });
  }

  test("counts a decision as untried when the write does not say", async () => {
    await expectAccepted(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, created_at)
      VALUES (13, 1, 'enc:1:a:b', 'accepted', 1)`);
    const saved = await getDb().execute(
      "SELECT attempt_count FROM payment_case_decisions WHERE case_id = 13",
    );
    expect(Number(saved.rows[0]?.attempt_count)).toBe(0);
  });

  test("gives each decision its own number", async () => {
    // The waiting-to-retry index finds a decision by its number, so two
    // sharing one would hide each other from the worker.
    await expectAccepted(aDecision("11, 1, 'enc:1:a:b', 'accepted', 0, 1"));
    await expectAccepted(aDecision("11, 2, 'enc:1:a:b', 'accepted', 0, 1"));
    const saved = await getDb().execute(
      "SELECT id FROM payment_case_decisions WHERE case_id = 11",
    );
    const ids = saved.rows.map((row) => Number(row.id));
    expect(ids.every((id) => id > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  test("refuses a second decision on the same version of a problem", async () => {
    // One version of a problem may only be settled once, so a double-click
    // cannot give the money back twice.
    await expectAccepted(aDecision("12, 1, 'enc:1:a:b', 'accepted', 0, 1"));
    await expectRefusedAsRepeat(
      aDecision("12, 1, 'enc:1:c:d', 'accepted', 0, 2"),
    );
  });
});
