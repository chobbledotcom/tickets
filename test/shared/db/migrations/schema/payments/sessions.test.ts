import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectAccepted,
  expectRefused,
  expectRefusedAsRepeat,
} from "./refuses.ts";

describeWithEnv("db > payment session rules", { db: true }, () => {
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
    ).rejects.toThrow("NOT NULL constraint failed");
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

  test("lets a payment change after its buyer's details were cleared", async () => {
    // Clearing the details does not freeze the money record: a refund landing
    // later moves the last-changed time past the clearing. Floored on the last
    // change instead, that ordinary update would be turned away.
    await expectAccepted(`INSERT INTO payment_sessions
      (id, origin, state, revision, created_at, updated_at, redacted_at,
       result_state, ticket_state, completion_state, legacy_runtime)
      VALUES ('redacted-then-refunded', 'legacy', 'fully_refunded', 2, 100,
        200, 150, 'none', 'none', 'none', 'enc:1:a:b')`);
  });

  test("refuses a payment cleared before it existed", async () => {
    await expectRefused(`INSERT INTO payment_sessions
      (id, origin, state, revision, created_at, updated_at, redacted_at,
       result_state, ticket_state, completion_state, legacy_runtime)
      VALUES ('cleared-too-early', 'legacy', 'completed', 1, 100, 100, 1,
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

  test("accepts a payment that asks for no money", async () => {
    // A free booking still opens a payment, so the amount asked for has a
    // floor of nothing rather than a penny.
    await expectAccepted(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, session_resource,
       session_reference_index, state, revision, created_at, updated_at,
       result_state, ticket_state, completion_state)
      VALUES ('asks-nothing', 'current', 'stripe', 'test', 'acct', 0, 'GBP',
        'enc:1:a:b', 'enc:1:a:b', 'asks-nothing-index', 'pending', 1, 1, 1,
        'none', 'none', 'none')`);
  });

  test("refuses a payment whose version counts from nothing", async () => {
    await expectRefused(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, session_resource,
       session_reference_index, state, revision, created_at, updated_at,
       result_state, ticket_state, completion_state)
      VALUES ('version-nothing', 'current', 'stripe', 'test', 'acct', 100,
        'GBP', 'enc:1:a:b', 'enc:1:a:b', 'version-nothing-index', 'pending',
        0, 1, 1, 'none', 'none', 'none')`);
  });

  test("starts a payment at version one when the write does not say", async () => {
    // Two workers tell each other apart by the version, so a payment written
    // without one still has to start somewhere they can both see.
    await expectAccepted(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, session_resource,
       session_reference_index, state, created_at, updated_at,
       result_state, ticket_state, completion_state)
      VALUES ('no-version-given', 'current', 'stripe', 'test', 'acct', 100,
        'GBP', 'enc:1:a:b', 'enc:1:a:b', 'no-version-given-index', 'pending',
        1, 1, 'none', 'none', 'none')`);
    const saved = await getDb().execute(
      `SELECT revision FROM payment_sessions WHERE id = 'no-version-given'`,
    );
    expect(Number(saved.rows[0]?.revision)).toBe(1);
  });

  test("refuses a payment pointed at a booking that cannot exist", async () => {
    // Bookings are numbered from one, so a payment claiming booking nothing
    // points at no booking at all.
    await expectRefused(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, session_resource,
       session_reference_index, state, revision, created_at, updated_at,
       attendee_id, result_state, ticket_state, completion_state)
      VALUES ('booking-nothing', 'current', 'stripe', 'test', 'acct', 100,
        'GBP', 'enc:1:a:b', 'enc:1:a:b', 'booking-nothing-index', 'pending',
        1, 1, 1, 0, 'none', 'none', 'none')`);
  });

  test("refuses a second payment found by the same lookup code", async () => {
    // The provider's callback finds its payment by this code, so two payments
    // sharing one would each answer to the other's money.
    await expectAccepted(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, session_resource,
       session_reference_index, state, revision, created_at, updated_at,
       result_state, ticket_state, completion_state)
      VALUES ('first-of-code', 'current', 'stripe', 'test', 'acct', 100,
        'GBP', 'enc:1:a:b', 'enc:1:a:b', 'shared-code', 'pending', 1, 1, 1,
        'none', 'none', 'none')`);
    await expectRefusedAsRepeat(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, session_resource,
       session_reference_index, state, revision, created_at, updated_at,
       result_state, ticket_state, completion_state)
      VALUES ('second-of-code', 'current', 'stripe', 'test', 'acct', 100,
        'GBP', 'enc:1:a:b', 'enc:1:a:b', 'shared-code', 'pending', 1, 1, 1,
        'none', 'none', 'none')`);
  });
});
