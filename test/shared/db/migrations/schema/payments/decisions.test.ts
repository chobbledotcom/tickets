import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectRefused } from "./refuses.ts";

describeWithEnv("db > payment decision and message rules", { db: true }, () => {
  test("refuses a retry booked before the attempt it follows", async () => {
    // Booking the next try before the last attempt makes it due immediately,
    // which turns waiting between tries into asking the provider on a loop.
    await expectRefused(`INSERT INTO payment_case_decisions
      (case_id, case_revision, claim, state, attempt_count, created_at,
       last_attempt_at, next_retry_at, last_error)
      VALUES (1, 1, 'enc:1:a:b', 'retrying', 1, 0, 100, 1, 'enc:1:a:b')`);
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
});
