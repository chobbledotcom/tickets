import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectAccepted,
  expectRefused,
  expectRefusedAsRepeat,
} from "./refuses.ts";

const COLUMNS =
  "id, origin, provider, mode, account_id, expected_amount, expected_currency, booking_intent, session_resource, session_reference_index, state, revision, created_at, updated_at, result_state, ticket_state, completion_state";

const aPayment = (id: string, index: string, intent = "'enc:1:a:b'") =>
  `INSERT INTO payment_sessions (${COLUMNS})
    VALUES ('${id}', 'current', 'stripe', 'test', 'acct', 100, 'GBP',
      ${intent}, 'enc:1:a:b', '${index}', 'pending', 1, 1, 1,
      'none', 'none', 'none')`;

describeWithEnv("db > payment session rules", { db: true }, () => {
  test("refuses a session with no id", async () => {
    // SQLite lets a text primary key hold NULL unless the table says
    // otherwise, and a payment with no id can never be looked up again.
    await expect(
      getDb().execute(`INSERT INTO payment_sessions
        (id, origin, state, revision, created_at, updated_at,
         result_state, ticket_state, completion_state)
        VALUES (NULL, 'legacy', 'created', 1, 1, 1, 'none', 'none', 'none')`),
    ).rejects.toThrow("NOT NULL constraint failed");
  });

  // The buyer's details, what the payment turned out to be, and the tickets
  // all live behind an envelope. This is the one rule the table still keeps,
  // because it checks what landed rather than what the code meant to write.
  for (const [name, intent] of [
    ["in plain words", "'Jane Smith'"],
    ["behind an upper-case envelope", "'ENC:1:a:b'"],
    ["wearing an envelope with nothing in it", "'enc:1:Jane Smith'"],
  ] as const) {
    test(`refuses a booking held ${name}`, async () => {
      await expectRefused(aPayment("plain", "plain-index", intent));
    });
  }

  test("refuses a booking that is bytes only reading like an envelope", async () => {
    await expectRefused({
      args: [new TextEncoder().encode("enc:1:a:b")],
      sql: `INSERT INTO payment_sessions (${COLUMNS})
        VALUES ('bytes', 'current', 'stripe', 'test', 'acct', 100, 'GBP',
          ?, 'enc:1:a:b', 'bytes-index', 'pending', 1, 1, 1,
          'none', 'none', 'none')`,
    });
  });

  test("starts a payment at version one when the write does not say", async () => {
    await expectAccepted(`INSERT INTO payment_sessions
      (id, origin, state, created_at, updated_at, result_state, ticket_state,
       completion_state)
      VALUES ('no-version', 'legacy', 'created', 1, 1, 'none', 'none', 'none')`);
    const saved = await getDb().execute(
      "SELECT revision FROM payment_sessions WHERE id = 'no-version'",
    );
    expect(Number(saved.rows[0]?.revision)).toBe(1);
  });

  test("refuses a second payment found by the same lookup code", async () => {
    // The provider's callback finds its payment by this code, so two payments
    // sharing one would each answer to the other's money.
    await expectAccepted(aPayment("first-of-code", "shared-code"));
    await expectRefusedAsRepeat(aPayment("second-of-code", "shared-code"));
  });
});
