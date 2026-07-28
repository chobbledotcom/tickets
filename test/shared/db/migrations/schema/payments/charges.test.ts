import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectAccepted, expectRefused } from "./refuses.ts";

describeWithEnv("db > payment charge rules", { db: true }, () => {
  test("rejects refunded money above its captured charge", async () => {
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, created_at, updated_at, observed_at)
      VALUES ('payment', 'stripe', 'stripe_payment_intent', 'enc:1:a:b',
        'index', 100, 'GBP', 101, 'failed', 1, 1, 1)`);
  });

  test("uses the Stripe payment intent resource kind", async () => {
    await expectAccepted(`INSERT INTO payment_charges
      (payment_id, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, created_at, updated_at, observed_at)
      VALUES ('current-payment', 'stripe', 'stripe_payment_intent',
        'enc:1:a:b', 'current-index', 100, 'GBP', 0, 'none', 1, 1, 1)`);
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, created_at, updated_at, observed_at)
      VALUES ('old-kind', 'stripe', 'stripe_charge', 'enc:1:a:b',
        'old-index', 100, 'GBP', 0, 'none', 1, 1, 1)`);
  });

  test("permits only quarantined unknown-money legacy charges", async () => {
    await expectAccepted(`INSERT INTO payment_charges
      (payment_id, origin, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, provider_refunded_at, legacy_source,
       created_at, updated_at, observed_at)
      VALUES ('legacy-payment', 'legacy', NULL, NULL, 'hyb:1:key:iv:text',
        NULL, NULL, NULL, NULL, 'unknown', 1750000000000,
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

    await expectRefused(`INSERT INTO payment_charges
      (payment_id, origin, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, legacy_source, created_at, updated_at, observed_at)
      VALUES ('invented-money', 'legacy', 'stripe', 'stripe_payment_intent',
        'hyb:1:key:iv:text', 'made-up-index', 100, 'GBP', 100, 'completed',
        'processed_payments', 1, 1, 1)`);
  });

  test("refuses a current charge with no refunded total", async () => {
    // The rule that keeps the refunded total within the captured amount
    // compares against NULL when the total is missing, and a comparison with
    // NULL passes. The total has to be demanded outright.
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency,
       refund_state, created_at, updated_at, observed_at)
      VALUES ('no-refunded-total', 'stripe', 'stripe_payment_intent',
        'enc:1:a:b', 'no-refunded-index', 100, 'GBP', 'none', 1, 1, 1)`);
  });

  test("refuses a current charge that names no provider", async () => {
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, created_at, updated_at, observed_at)
      VALUES ('no-provider', NULL, NULL, 'enc:1:a:b',
        'no-provider-index', 100, 'GBP', 0, 'none', 1, 1, 1)`);
  });

  test("refuses an old charge that does not say where it came from", async () => {
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, origin, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, legacy_source, created_at, updated_at, observed_at)
      VALUES ('no-source', 'legacy', NULL, NULL, 'hyb:1:key:iv:text',
        NULL, NULL, NULL, NULL, 'unknown', NULL, 1, 1, 1)`);
  });

  test("refuses an old charge whose refund time is not a time", async () => {
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, origin, provider_reference, refund_state,
       provider_refunded_at, legacy_source, created_at, updated_at,
       observed_at)
      VALUES ('bad-refund-time', 'legacy', 'hyb:1:key:iv:text', 'unknown',
        'banana', 'processed_payments', 1, 1, 1)`);
  });

  test("refuses more refund work when nothing is left to give back", async () => {
    // Everything taken has already gone back, so asking the provider for more
    // would either be refused or hand the money over twice.
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, pending_refund_idempotency_key,
       pending_refund_key_index, created_at, updated_at, observed_at)
      VALUES ('nothing-left', 'stripe', 'stripe_payment_intent', 'enc:1:a:b',
        'nothing-left-index', 100, 'GBP', 100, 'requested', 'enc:1:a:b',
        'key-index', 1, 1, 1)`);
  });

  // The charge's own index is blank in the third case, so a paid charge that
  // a provider callback could never find again is refused too.
  for (const [name, chargeIndex, refundIndex] of [
    ["pending refund index is empty", "refund-index-charge", ""],
    ["pending refund index is only spaces", "refund-index-charge", "   "],
    ["own reference index is only spaces", "   ", "enc-refund-index"],
  ] as const) {
    test(`refuses a charge whose ${name}`, async () => {
      await expectRefused(`INSERT INTO payment_charges
        (payment_id, provider, resource_kind, provider_reference,
         reference_index, captured_amount, currency, refunded_amount,
         refund_state, pending_refund_id, pending_refund_index,
         created_at, updated_at, observed_at)
        VALUES ('blank-refund-index', 'stripe', 'stripe_payment_intent',
          'enc:1:a:b', '${chargeIndex}', 100, 'GBP', 0, 'pending',
          'enc:1:a:b', '${refundIndex}', 1, 1, 1)`);
    });
  }
});
