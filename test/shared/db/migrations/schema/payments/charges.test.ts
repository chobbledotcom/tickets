import { it as test } from "@std/testing/bdd";
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

  test("refuses an old charge refunded before the money was seen", async () => {
    // A copied charge is seen at the moment the payment was processed, and a
    // refund can only come after that.
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, origin, provider_reference, refund_state,
       provider_refunded_at, legacy_source, created_at, updated_at,
       observed_at)
      VALUES ('refund-before-charge', 'legacy', 'hyb:1:k:i:c', 'unknown',
        1, 'processed_payments', 1, 1, 100)`);
  });

  // A provider's own name for money is hidden either with this site's key or
  // in the older wrapped form. Which one depends on where the charge came
  // from; that it is one of them does not.
  for (const [name, reference] of [
    ["in plain words", "pi_12345"],
    ["behind an envelope with nothing in it", "enc:1:pi_12345"],
    ["behind a half-written older envelope", "hyb:1:key:iv"],
  ] as const) {
    test(`refuses a charge naming its money ${name}`, async () => {
      await expectRefused(`INSERT INTO payment_charges
        (payment_id, origin, provider_reference, refund_state,
         legacy_source, created_at, updated_at, observed_at)
        VALUES ('bare-reference', 'legacy', '${reference}', 'unknown',
          'processed_payments', 1, 1, 1)`);
    });
  }

  // GLOB's ?* swallows extra separators, so an envelope with one part too
  // many looked hidden while nothing could ever read it back.
  for (const [name, reference] of [
    ["one part too many", "enc:1:iv:text:extra"],
    ["an older envelope with one part too many", "hyb:1:key:iv:text:extra"],
  ] as const) {
    test(`refuses a charge whose money is named with ${name}`, async () => {
      await expectRefused(`INSERT INTO payment_charges
        (payment_id, origin, provider_reference, refund_state,
         legacy_source, created_at, updated_at, observed_at)
        VALUES ('too-many-parts', 'legacy', '${reference}', 'unknown',
          'processed_payments', 1, 1, 1)`);
    });
  }

  test("refuses an old charge that came from nowhere in particular", async () => {
    // Only one charge per payment may come from a given old table, so a name
    // of only spaces would slip past that as a second, different "nowhere".
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, origin, provider_reference, refund_state,
       legacy_source, created_at, updated_at, observed_at)
      VALUES ('blank-source', 'legacy', 'hyb:1:k:i:c', 'unknown',
        '   ', 1, 1, 1)`);
  });

  test("refuses an old charge whose refund time is not a time", async () => {
    await expectRefused(`INSERT INTO payment_charges
      (payment_id, origin, provider_reference, refund_state,
       provider_refunded_at, legacy_source, created_at, updated_at,
       observed_at)
      VALUES ('bad-refund-time', 'legacy', 'hyb:1:key:iv:text', 'unknown',
        'banana', 'processed_payments', 1, 1, 1)`);
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
