import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decrypt, ENCRYPTION_PREFIX } from "#crypto/encryption.ts";
import { HYBRID_PREFIX } from "#crypto/keys.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import {
  loadIndexedPaymentReference,
  loadPaymentReference,
  matchingPaymentReferenceIndexes,
  paymentReferenceIndex,
  type preparePaymentReferenceWrite,
  storePaymentReference,
  type unclaimedPaymentReference,
} from "#db/payment-reference-store.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { taggedPaymentReference } from "#test-utils/processed-payments.ts";

describeWithEnv("db > payment reference store", { db: true }, () => {
  test("stores a tagged reference encrypted with its provider-aware index", async () => {
    const payment = taggedPaymentReference("pi_secret", "square");
    const stored = await storePaymentReference(payment);

    expect(stored.encrypted).not.toContain(payment.reference);
    expect(stored.encrypted.startsWith(HYBRID_PREFIX)).toBe(true);
    expect(stored.encrypted.startsWith(ENCRYPTION_PREFIX)).toBe(false);
    await expect(
      decrypt(stored.encrypted as unknown as EnvKeyEncrypted),
    ).rejects.toThrow();
    expect(stored.index).toBe(await paymentReferenceIndex(payment));
    expect(
      await loadPaymentReference(
        stored.encrypted,
        await getTestPrivateKey(),
        "stored test payment reference",
      ),
    ).toEqual(payment);
  });

  test("writer inputs cannot represent an untagged reference", () => {
    const historical = { kind: "untagged", reference: "pi_old" } as const;

    // @ts-expect-error Historical identities are read-only.
    const storeInput: Parameters<typeof storePaymentReference>[0] = historical;
    // @ts-expect-error A finalizer cannot prepare historical identity.
    const prepareInput: Parameters<typeof preparePaymentReferenceWrite>[0] =
      historical;
    // @ts-expect-error A historical identity cannot claim a new write.
    const claimInput: Parameters<typeof unclaimedPaymentReference>[0] =
      historical;

    expect([storeInput, prepareInput, claimInput]).toEqual([
      historical,
      historical,
      historical,
    ]);
  });

  test("a tagged reference matches itself and the old untagged spelling only", async () => {
    const payment = taggedPaymentReference("pi_ids", "square");

    expect(await matchingPaymentReferenceIndexes(payment)).toEqual([
      await paymentReferenceIndex(payment),
      await paymentReferenceIndex({ kind: "untagged", reference: "pi_ids" }),
    ]);
  });

  test("an untagged reference matches every provider's tagged spelling", async () => {
    const historical = { kind: "untagged", reference: "pi_ids" } as const;

    const indexes = await matchingPaymentReferenceIndexes(historical);

    expect(indexes[0]).toBe(await paymentReferenceIndex(historical));
    expect(indexes).toContain(
      await paymentReferenceIndex(taggedPaymentReference("pi_ids", "square")),
    );
    expect(indexes).toContain(
      await paymentReferenceIndex(taggedPaymentReference("pi_ids", "sumup")),
    );
  });

  test("a row with no stored index gets one derived from its reference", async () => {
    const payment = taggedPaymentReference("pi_reindex", "square");
    const stored = await storePaymentReference(payment);

    const loaded = await loadIndexedPaymentReference(
      {
        payment_reference: stored.encrypted,
        payment_reference_index: "",
        payment_session_id: "reindex",
      },
      await getTestPrivateKey(),
    );

    expect(loaded).toEqual({ index: stored.index, payment });
  });

  test("a stored index that names another reference is refused loudly", async () => {
    const stored = await storePaymentReference(
      taggedPaymentReference("pi_real", "square"),
    );

    await expect(
      loadIndexedPaymentReference(
        {
          payment_reference: stored.encrypted,
          payment_reference_index: "not-the-derived-index",
          payment_session_id: "mismatch",
        },
        await getTestPrivateKey(),
      ),
    ).rejects.toThrow(
      "Payment reference index does not match stored reference",
    );
  });

  test("an unreadable reference names the column it came from", async () => {
    await expect(
      loadIndexedPaymentReference(
        {
          payment_reference: "not-encrypted-at-all",
          payment_reference_index: "",
          payment_session_id: "garbage",
        },
        await getTestPrivateKey(),
      ),
    ).rejects.toThrow("processed_payments.payment_reference");
  });
});
