import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentChargeTable } from "#shared/db/migrations/schema/payments/charges.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectAccepted,
  expectRefused,
  expectRefusedAsRepeat,
} from "./refuses.ts";

const COLUMNS =
  "payment_id, provider, resource_kind, provider_reference, reference_index, captured_amount, currency, refunded_amount, refund_state, created_at, updated_at, observed_at";

const aCharge = (paymentId: string, index: string, reference = "'enc:1:a:b'") =>
  `INSERT INTO payment_charges (${COLUMNS})
    VALUES ('${paymentId}', 'stripe', 'stripe_payment_intent', ${reference},
      '${index}', 100, 'GBP', 0, 'none', 1, 1, 1)`;

test("is what the money actually taken is made of", () => {
  const [name, table] = paymentChargeTable;

  expect(name).toBe("payment_charges");
  expect(table.columns.map(([held]) => held)).toEqual([
    "id",
    "payment_id",
    "origin",
    "provider",
    "resource_kind",
    "provider_reference",
    "reference_index",
    "captured_amount",
    "currency",
    "refunded_amount",
    "refund_state",
    "pending_refund_id",
    "pending_refund_index",
    "pending_refund_idempotency_key",
    "pending_refund_key_index",
    "provider_refunded_at",
    "legacy_source",
    "created_at",
    "updated_at",
    "observed_at",
  ]);
});

describeWithEnv("db > payment charge rules", { db: true }, () => {
  // A provider's own name for the money is hidden either with this site's key
  // or in the older wrapped form a copied record uses. That it is one of them
  // is the rule the table keeps.
  for (const [name, reference] of [
    ["in plain words", "'pi_12345'"],
    ["behind an upper-case envelope", "'ENC:1:a:b'"],
    ["wearing an envelope with nothing in it", "'enc:1:pi_12345'"],
  ] as const) {
    test(`refuses money whose provider name is held ${name}`, async () => {
      await expectRefused(aCharge("plain", "plain-index", reference));
    });
  }

  test("accepts money copied across, wrapped the older way", async () => {
    await expectAccepted(aCharge("copied", "copied-index", "'hyb:1:a:b:c'"));
  });

  // Both are the provider's own words about a refund still going, so neither
  // may sit in the open.
  for (const [name, column] of [
    ["the refund it sent", "pending_refund_id"],
    ["the key that stops it asking twice", "pending_refund_idempotency_key"],
  ] as const) {
    test(`refuses a charge naming ${name} in plain words`, async () => {
      await expectRefused(`INSERT INTO payment_charges (${COLUMNS}, ${column})
        VALUES ('plain-refund', 'stripe', 'stripe_payment_intent', 'enc:1:a:b',
          'plain-refund-index', 100, 'GBP', 0, 'pending', 1, 1, 1, 're_12345')`);
    });
  }

  test("refuses a second charge for the same money on one payment", async () => {
    // Both rows would answer to the same provider callback, so the same money
    // could be spoken for twice.
    await expectAccepted(aCharge("same-money", "same-money-index"));
    await expectRefusedAsRepeat(aCharge("same-money", "same-money-index"));
  });

  test("refuses copying the same old table's money twice onto one payment", async () => {
    // The upgrade has to be safe to run again, so a second copy from the same
    // old table is the repeat it is meant to skip.
    const copied = (reference: string) =>
      `INSERT INTO payment_charges
        (payment_id, origin, provider_reference, captured_amount, currency,
         refunded_amount, refund_state, legacy_source, created_at, updated_at,
         observed_at)
        VALUES ('copied-twice', 'legacy', '${reference}', 100, 'GBP', 0,
          'unknown', 'processed_payments', 1, 1, 1)`;
    await expectAccepted(copied("hyb:1:a:b:c"));
    await expectRefusedAsRepeat(copied("hyb:1:d:e:f"));
  });
});
