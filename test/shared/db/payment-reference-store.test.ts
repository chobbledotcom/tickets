import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decrypt, ENCRYPTION_PREFIX } from "#shared/crypto/encryption.ts";
import { HYBRID_PREFIX } from "#shared/crypto/keys.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  loadPaymentReference,
  paymentReferenceIndex,
  type preparePaymentReferenceWrite,
  storePaymentReference,
  type unclaimedPaymentReference,
} from "#shared/db/payment-reference-store.ts";
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
});
