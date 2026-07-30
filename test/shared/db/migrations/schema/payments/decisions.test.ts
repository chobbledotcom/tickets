import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectAccepted,
  expectRefused,
  expectRefusedAsRepeat,
} from "./refuses.ts";

describeWithEnv("db > payment decision and message rules", { db: true }, () => {
  test("refuses a retry booked before the attempt it follows", async () => {
    // Booking the next try before the last attempt makes it due immediately,
    // which turns waiting between tries into asking the provider on a loop.
    await expectRefused(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, attempt_count, created_at,
       last_attempt_at, next_retry_at, last_error)
      VALUES (1, 1, 'enc:1:a:b', 'retrying', 1, 0, 100, 1, 'enc:1:a:b')`);
  });

  // What was decided, and what went wrong, are both allowed to be missing —
  // but never held in the open. Missing and hidden are the only two shapes.
  for (const [name, decision, lastError] of [
    ["what was decided", "'Give it back'", "NULL"],
    ["what went wrong", "'enc:1:a:b'", "'Card declined'"],
  ] as const) {
    test(`refuses a decision keeping ${name} in plain words`, async () => {
      await expectRefused(`INSERT INTO payment_case_decisions
        (case_id, case_revision, claim, state, attempt_count, created_at,
         decision, last_error)
        VALUES (1, 1, 'enc:1:a:b', 'accepted', 0, 0,
          ${decision}, ${lastError})`);
    });
  }

  test("accepts a decision that has neither yet", async () => {
    await expectAccepted(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, attempt_count, created_at,
       decision, last_error)
      VALUES (2, 1, 'enc:1:a:b', 'accepted', 0, 0, NULL, NULL)`);
  });

  // This is the one column holding the buyer's name, email, phone and
  // address. Plain words are obviously not encrypted; a bare prefix is the
  // one that looks encrypted at a glance and is not.
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

  // A decision is about one problem, at one version of it. Both are counted
  // from one, so nothing names neither.
  for (const [name, caseId, caseRevision] of [
    ["a problem numbered nothing", 0, 1],
    ["a version numbered nothing", 3, 0],
  ] as const) {
    test(`refuses a decision about ${name}`, async () => {
      await expectRefused(`INSERT INTO payment_case_decisions
        (case_id, case_revision, claim, state, attempt_count, created_at,
         last_error)
        VALUES (${caseId}, ${caseRevision}, 'enc:1:a:b', 'accepted', 0, 1,
          NULL)`);
    });
  }

  test("accepts a decision the owner has taken but nothing has tried", async () => {
    // Taking the decision and carrying it out are separate events, so a
    // freshly taken one has been tried no times at all.
    await expectAccepted(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, attempt_count, created_at,
       last_error)
      VALUES (10, 1, 'enc:1:a:b', 'accepted', 0, 1, NULL)`);
  });

  test("counts a decision as untried when the write does not say", async () => {
    // A decision is written the moment the owner makes it, before any worker
    // picks it up. Starting the count at one would say a try had happened
    // that never did, and the row rule tying a try to its time would refuse
    // the write outright.
    await expectAccepted(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, created_at, last_error)
      VALUES (13, 1, 'enc:1:a:b', 'accepted', 1, NULL)`);
    const saved = await getDb().execute(
      "SELECT attempt_count FROM payment_case_decisions WHERE case_id = 13",
    );
    expect(Number(saved.rows[0]?.attempt_count)).toBe(0);
  });

  test("gives each decision its own number", async () => {
    // The waiting-to-retry index finds a decision by its number, so two
    // sharing one would hide each other from the worker.
    await expectAccepted(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, attempt_count, created_at,
       last_error)
      VALUES (11, 1, 'enc:1:a:b', 'accepted', 0, 1, NULL)`);
    await expectAccepted(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, attempt_count, created_at,
       last_error)
      VALUES (11, 2, 'enc:1:a:b', 'accepted', 0, 1, NULL)`);
    const saved = await getDb().execute(
      `SELECT id FROM payment_case_decisions WHERE case_id = 11
        ORDER BY case_revision`,
    );
    const ids = saved.rows.map((row) => Number(row.id));
    // Distinct and real, not consecutive: how SQLite hands numbers out is its
    // business, and a gap is still two decisions the worker can tell apart.
    expect(ids.every((id) => id > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  test("refuses a second decision on the same version of a problem", async () => {
    // One version of a problem may only be settled once, so a double-click
    // cannot give the money back twice.
    await expectAccepted(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, attempt_count, created_at,
       last_error)
      VALUES (12, 1, 'enc:1:a:b', 'accepted', 0, 1, NULL)`);
    await expectRefusedAsRepeat(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, attempt_count, created_at,
       last_error)
      VALUES (12, 1, 'enc:1:c:d', 'accepted', 0, 2, NULL)`);
  });
});
