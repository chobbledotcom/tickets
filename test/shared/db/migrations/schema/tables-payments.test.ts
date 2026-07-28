import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { paymentTables } from "#shared/db/migrations/schema/payments/index.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete payment aggregate schema declaration exact", async () => {
  expect(await jsonHash(paymentTables)).toBe(
    "10f0a68a5a2b84b48116b44237cb36ff24a4ab94e7ce4257b98628745025f008",
  );
});

describeWithEnv("db > payment aggregate constraints", { db: true }, () => {
  test("requires complete ownership and money on current sessions", async () => {
    await expect(
      getDb().execute(`INSERT INTO payment_sessions
        (id, origin, state, revision, created_at, updated_at,
         result_state, ticket_state, completion_state, legacy_runtime)
        VALUES ('incomplete', 'current', 'created', 1, 1, 1,
          'none', 'none', 'none', NULL)`),
    ).rejects.toThrow("CHECK constraint failed");
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
    await getDb().execute(`INSERT INTO payment_sessions
      (id, origin, provider, mode, account_id, expected_amount,
       expected_currency, booking_intent, checkout_create, state, revision,
       created_at, updated_at, result_state, ticket_state, completion_state)
      VALUES ('creating', 'current', 'stripe', 'test', 'acct', 100, 'GBP',
        'enc:1:a:b', 'enc:1:a:b', 'created', 1, 1, 1, 'none', 'none', 'none')`);

    await expect(
      getDb().execute(
        "UPDATE payment_sessions SET state = 'pending' WHERE id = 'creating'",
      ),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("rejects refunded money above its captured charge", async () => {
    await expect(
      getDb().execute(`INSERT INTO payment_charges
        (payment_id, provider, resource_kind, provider_reference,
         reference_index, captured_amount, currency, refunded_amount,
         refund_state, created_at, updated_at, observed_at)
        VALUES ('payment', 'stripe', 'stripe_payment_intent', 'enc:1:a:b',
          'index', 100, 'GBP', 101, 'failed', 1, 1, 1)`),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("uses the Stripe payment intent resource kind", async () => {
    await getDb().execute(`INSERT INTO payment_charges
      (payment_id, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, created_at, updated_at, observed_at)
      VALUES ('current-payment', 'stripe', 'stripe_payment_intent',
        'enc:1:a:b', 'current-index', 100, 'GBP', 0, 'none', 1, 1, 1)`);
    await expect(
      getDb().execute(`INSERT INTO payment_charges
        (payment_id, provider, resource_kind, provider_reference,
         reference_index, captured_amount, currency, refunded_amount,
         refund_state, created_at, updated_at, observed_at)
        VALUES ('old-kind', 'stripe', 'stripe_charge', 'enc:1:a:b',
          'old-index', 100, 'GBP', 0, 'none', 1, 1, 1)`),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("permits only quarantined unknown-money legacy charges", async () => {
    await getDb().execute(`INSERT INTO payment_charges
      (payment_id, origin, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, provider_refunded_at, legacy_source,
       created_at, updated_at, observed_at)
      VALUES ('legacy-payment', 'legacy', NULL, NULL, 'hyb:1:reference',
        NULL, NULL, NULL, NULL, 'unknown', '2026-07-25T10:00:00.000Z',
        'processed_payments', 1, 1, 1)`);
    const stored = await getDb().execute(`SELECT provider, resource_kind,
      reference_index, captured_amount, currency, refunded_amount, refund_state
      FROM payment_charges WHERE payment_id = 'legacy-payment'`);
    expect(stored.rows).toEqual([
      {
        captured_amount: null,
        currency: null,
        provider: null,
        reference_index: null,
        refund_state: "unknown",
        refunded_amount: null,
        resource_kind: null,
      },
    ]);

    await expect(
      getDb().execute(`INSERT INTO payment_charges
        (payment_id, origin, provider, resource_kind, provider_reference,
         reference_index, captured_amount, currency, refunded_amount,
         refund_state, legacy_source, created_at, updated_at, observed_at)
        VALUES ('invented-money', 'legacy', 'stripe', 'stripe_payment_intent',
          'hyb:1:reference', 'made-up-index', 100, 'GBP', 100, 'completed',
          'processed_payments', 1, 1, 1)`),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("refuses a current charge with no refunded total", async () => {
    // The rule that keeps the refunded total within the captured amount
    // compares against NULL when the total is missing, and a comparison with
    // NULL passes. The total has to be demanded outright.
    await expect(
      getDb().execute(`INSERT INTO payment_charges
        (payment_id, provider, resource_kind, provider_reference,
         reference_index, captured_amount, currency,
         refund_state, created_at, updated_at, observed_at)
        VALUES ('no-refunded-total', 'stripe', 'stripe_payment_intent',
          'enc:1:a:b', 'no-refunded-index', 100, 'GBP', 'none', 1, 1, 1)`),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("refuses a current charge that names no provider", async () => {
    await expect(
      getDb().execute(`INSERT INTO payment_charges
        (payment_id, provider, resource_kind, provider_reference,
         reference_index, captured_amount, currency, refunded_amount,
         refund_state, created_at, updated_at, observed_at)
        VALUES ('no-provider', NULL, NULL, 'enc:1:a:b',
          'no-provider-index', 100, 'GBP', 0, 'none', 1, 1, 1)`),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("refuses an old charge that does not say where it came from", async () => {
    await expect(
      getDb().execute(`INSERT INTO payment_charges
        (payment_id, origin, provider, resource_kind, provider_reference,
         reference_index, captured_amount, currency, refunded_amount,
         refund_state, legacy_source, created_at, updated_at, observed_at)
        VALUES ('no-source', 'legacy', NULL, NULL, 'hyb:1:reference',
          NULL, NULL, NULL, NULL, 'unknown', NULL, 1, 1, 1)`),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("refuses a session whose provider reference index is empty", async () => {
    // The index is how a provider's checkout is found again. An empty one is
    // stored and looks attached, but can never match the real derived index.
    await expect(
      getDb().execute(`INSERT INTO payment_sessions
        (id, origin, provider, mode, account_id, expected_amount,
         expected_currency, booking_intent, session_resource,
         session_reference_index, state, revision, created_at, updated_at,
         result_state, ticket_state, completion_state)
        VALUES ('empty-index', 'current', 'stripe', 'test', 'acct', 100, 'GBP',
          'enc:1:a:b', 'enc:1:a:b', '', 'pending', 1, 1, 1,
          'none', 'none', 'none')`),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("refuses case alert bookkeeping that is not a real time or revision", async () => {
    await expect(
      getDb().execute(`INSERT INTO payment_cases
        (payment_id, resource, resource_index, reason, state,
         first_observed_at, last_observed_at, consecutive_count, evidence,
         revision, alerted_at, alerted_revision)
        VALUES ('bad-alert', 'enc:1:a:b', 'bad-alert-index', 'network_error',
          'needs_action', 1, 1, 1, 'enc:1:a:b', 1, 'bad', 0)`),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("requires retrying cases to have a next reconcile time", async () => {
    await expect(
      getDb().execute(`INSERT INTO payment_cases
        (payment_id, resource, resource_index, reason, state,
         first_observed_at, last_observed_at, next_reconcile_at,
         consecutive_count, evidence, revision)
        VALUES ('payment', 'enc:1:a:b', 'index', 'network_error',
          'retrying', 1, 1, NULL, 1, 'enc:1:a:b', 1)`),
    ).rejects.toThrow("CHECK constraint failed");
  });

  test("creates every aggregate lookup index", async () => {
    const result = await getDb().execute(
      `SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name IN ('payment_sessions', 'payment_charges', 'payment_cases',
                            'payment_case_decisions', 'payment_completion_effects',
                            'payment_completion_deliveries')
          AND name NOT LIKE 'sqlite_autoindex%'
        ORDER BY name`,
    );
    expect(result.rows.map((row) => row.name)).toEqual([
      "idx_payment_case_decisions_retry",
      "idx_payment_case_decisions_revision",
      "idx_payment_cases_alert",
      "idx_payment_cases_payment_resource",
      "idx_payment_cases_reconcile",
      "idx_payment_cases_redaction",
      "idx_payment_charges_legacy_source",
      "idx_payment_charges_payment_reference",
      "idx_payment_charges_pending_refund",
      "idx_payment_charges_reference",
      "idx_payment_completion_deliveries_pending",
      "idx_payment_completion_deliveries_unique",
      "idx_payment_completion_effects_unique",
      "idx_payment_sessions_attendee",
      "idx_payment_sessions_reconcile",
      "idx_payment_sessions_redaction",
      "idx_payment_sessions_reference",
    ]);
  });
});
