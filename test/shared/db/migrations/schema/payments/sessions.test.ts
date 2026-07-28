import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectAccepted, expectRefused } from "./refuses.ts";

describeWithEnv("db > payment session rules", { db: true }, () => {
  test("requires complete ownership and money on current sessions", async () => {
    await expectRefused(`INSERT INTO payment_sessions
      (id, origin, state, revision, created_at, updated_at,
       result_state, ticket_state, completion_state, legacy_runtime)
      VALUES ('incomplete', 'current', 'created', 1, 1, 1,
        'none', 'none', 'none', NULL)`);
  });

  test("refuses a session with no id", async () => {
    // SQLite lets a text primary key hold NULL, and a rule that compares
    // against NULL passes rather than fails. Without saying so outright, a
    // payment with no id gets in, and nothing can ever look it up again.
    await expect(
      getDb().execute(`INSERT INTO payment_sessions
        (id, origin, state, revision, created_at, updated_at,
         result_state, ticket_state, completion_state, legacy_runtime)
        VALUES (NULL, 'legacy', 'created', 1, 1, 1,
          'none', 'none', 'none', 'enc:1:a:b')`),
    ).rejects.toThrow();
  });

  test("allows checkout creation data only on an unattached created session", async () => {
    // What the provider was asked to create is kept only while the checkout
    // has not been made yet. Once the payment moves on, that request is
    // history and must not still be sitting on the row.
    await expectAccepted(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, checkout_create, state, revision,
       created_at, updated_at, result_state, ticket_state, completion_state)
      VALUES ('creating', 'current', 'stripe', 'test', 'acct', 100, 'GBP',
        'enc:1:a:b', 'enc:1:a:b', 'created', 1, 1, 1, 'none', 'none', 'none')`);

    await expectRefused(
      "UPDATE payment_sessions SET state = 'pending' WHERE id = 'creating'",
    );
  });

  test("refuses a payment booked to be looked at before it existed", async () => {
    // The reconcile index would show a brand-new payment as already overdue,
    // so it would be picked up again and again with no wait between.
    await expectRefused(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, session_resource,
       session_reference_index, state, revision, created_at, updated_at,
       next_reconcile_at, result_state, ticket_state, completion_state)
      VALUES ('early-reconcile', 'current', 'stripe', 'test', 'acct', 100,
        'GBP', 'enc:1:a:b', 'enc:1:a:b', 'idx', 'pending', 1, 100, 100,
        1, 'none', 'none', 'none')`);
  });

  test("refuses a worker's claim that had already run out when it was made", async () => {
    // A claim that expires before the payment even existed is spent on
    // arrival, so a second worker can take the payment while the first still
    // believes it holds it.
    await expectRefused(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, session_resource,
       session_reference_index, state, revision, created_at, updated_at,
       lease_token, lease_expires_at, result_state, ticket_state,
       completion_state)
      VALUES ('stale-claim', 'current', 'stripe', 'test', 'acct', 100,
        'GBP', 'enc:1:a:b', 'enc:1:a:b', 'idx', 'pending', 1, 100, 100,
        'worker-1', 1, 'none', 'none', 'none')`);
  });

  test("refuses a current payment carrying an old payment's record", async () => {
    // legacy_runtime belongs to a copied payment. On a current one it is an
    // encrypted blob nothing accounts for, and no code path writes it.
    await expectRefused(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, session_resource,
       session_reference_index, state, revision, created_at, updated_at,
       result_state, ticket_state, completion_state, legacy_runtime)
      VALUES ('current-with-legacy', 'current', 'stripe', 'test', 'acct',
        100, 'GBP', 'enc:1:a:b', 'enc:1:a:b', 'idx', 'pending', 1, 1, 1,
        'none', 'none', 'none', 'enc:1:a:b')`);
  });

  test("refuses an empty claim on a payment", async () => {
    // An empty claim matches another empty one, so two workers could both
    // believe they had the payment to themselves.
    await expectRefused(`INSERT INTO payment_sessions
      (id, origin, state, revision, created_at, updated_at, result_state,
       ticket_state, completion_state, legacy_runtime, lease_token,
       lease_expires_at)
      VALUES ('empty-claim', 'legacy', 'created', 1, 1, 1, 'none', 'none',
        'none', 'enc:1:a:b', '', 9)`);
  });

  // Spaces count as blank. A guard that only refuses "" still lets "   "
  // through, and that is stored, looks attached, and can never match the real
  // derived index.
  for (const [name, blank] of [
    ["empty", ""],
    ["only spaces", "   "],
  ] as const) {
    test(`refuses a session whose provider reference index is ${name}`, async () => {
      await expectRefused(`INSERT INTO payment_sessions
        (id, origin, provider, mode, account_id, expected_amount,
         expected_currency, booking_intent, session_resource,
         session_reference_index, state, revision, created_at, updated_at,
         result_state, ticket_state, completion_state)
        VALUES ('blank-index', 'current', 'stripe', 'test', 'acct', 100, 'GBP',
          'enc:1:a:b', 'enc:1:a:b', '${blank}', 'pending', 1, 1, 1,
          'none', 'none', 'none')`);
    });
  }

  // Two ways a value can look encrypted without being it: the wrong case, and
  // the right prefix with nothing after it. SQLite's LIKE ignores case, so
  // "ENC:1:" once passed while no reader would ever decrypt it; and a prefix
  // alone leaves the buyer's details sitting there in plain sight.
  for (const [name, pretend] of [
    ["hidden behind an upper-case envelope", "ENC:1:a:b"],
    ["wearing an envelope with nothing in it", "enc:1:Jane Smith"],
  ] as const) {
    test(`refuses details ${name}`, async () => {
      await expectRefused(`INSERT INTO payment_sessions
        (id, origin, provider, mode, account_id, expected_amount,
         expected_currency, booking_intent, session_resource,
         session_reference_index, state, revision, created_at, updated_at,
         result_state, ticket_state, completion_state)
        VALUES ('pretend', 'current', 'stripe', 'test', 'acct', 100, 'GBP',
          '${pretend}', 'enc:1:a:b', 'pretend-index', 'pending', 1, 1, 1,
          'none', 'none', 'none')`);
    });
  }
});
