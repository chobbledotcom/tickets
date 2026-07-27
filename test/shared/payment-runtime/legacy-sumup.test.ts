import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { encryptWithKey } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { generateDataKey, wrapKeyWithToken } from "#shared/crypto/keys.ts";
import { executeBatch, getDb } from "#shared/db/client.ts";
import type { LegacyPaymentGroup } from "#shared/db/payments/legacy.ts";
import {
  legacyTargetStatements,
  prepareLegacyPayment,
} from "#shared/db/payments/legacy-copy.ts";
import { settings } from "#shared/db/settings.ts";
import { promoteLegacySumupPayment } from "#shared/payment-runtime/legacy-sumup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";

describeWithEnv("legacy SumUp promotion", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("promotes encrypted legacy runtime through one current aggregate", async () => {
    settings.setForTest({
      currency: "GBP",
      payment_provider: "sumup",
      sumup_api_key: "sk_test_legacy",
      sumup_merchant_code: "merchant-legacy",
    });
    const reference = "legacy-local-reference";
    const dataKey = await generateDataKey();
    const metadata = signedMeta(
      {
        email: "legacy@example.com",
        items: singleItem(7, 1, 1_000),
        name: "Legacy buyer",
      },
      1_000,
    );
    const group: LegacyPaymentGroup = {
      key: `sumup:${await hmacHash(reference)}`,
      runtime: {
        attendeePayment: null,
        checkoutStage: null,
        processedPayment: null,
        sumupCheckout: {
          createdAt: "2026-07-26T12:00:00.000Z",
          metadata: await encryptWithKey(JSON.stringify(metadata), dataKey),
          referenceIndex: await hmacHash(reference),
          sumupId: "sumup-checkout-legacy",
          wrappedKey: await wrapKeyWithToken(dataKey, reference),
        },
      },
    };
    await executeBatch(
      legacyTargetStatements(await prepareLegacyPayment(group)),
    );

    const first = await promoteLegacySumupPayment(reference);
    const second = await promoteLegacySumupPayment(reference);
    if (first === null || !("payment" in first)) {
      throw new Error("Expected promoted SumUp payment");
    }
    if (second === null || !("payment" in second)) {
      throw new Error("Expected replayed SumUp payment");
    }

    expect(first.payment).toMatchObject({
      bookingIntent: { email: "legacy@example.com" },
      expected: { amount: 1_000, currency: "GBP" },
      id: reference,
      provider: "sumup",
      session: { id: "sumup-checkout-legacy" },
    });
    expect(second.payment.id).toBe(reference);
    const rows = await getDb().execute(
      `SELECT origin, legacy_runtime IS NOT NULL AS kept_runtime
        FROM payment_sessions`,
    );
    expect(rows.rows).toEqual([{ kept_runtime: 1, origin: "current" }]);
  });
});
