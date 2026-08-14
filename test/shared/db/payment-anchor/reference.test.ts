import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentAnchorReference } from "#shared/db/payment-anchor/reference.ts";
import {
  loadPaymentReference,
  paymentReferenceIndex,
} from "#shared/db/payment-reference-store.ts";
import type { PaymentReference } from "#shared/payment/provider-reference.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { taggedPaymentReference } from "#test-utils/processed-payments.ts";

const untagged = (reference: string): PaymentReference => ({
  kind: "untagged",
  reference,
});

describeWithEnv("db > payment anchor > reference", { db: true }, () => {
  test("stores a tagged reference and every spelling that can already own it", async () => {
    const payment = taggedPaymentReference("pi_anchor_tagged", "square");
    const prepared = await paymentAnchorReference(payment);
    const taggedIndex = await paymentReferenceIndex(payment);
    const untaggedIndex = await paymentReferenceIndex(
      untagged(payment.reference),
    );

    expect(prepared.stored.index).toBe(taggedIndex);
    expect(prepared.matchingIndexes).toEqual([taggedIndex, untaggedIndex]);
    expect(prepared.stored.encrypted).not.toContain(payment.reference);
    expect(
      await loadPaymentReference(
        prepared.stored.encrypted,
        await getTestPrivateKey(),
        "tagged payment anchor test",
      ),
    ).toEqual(payment);
  });
});
