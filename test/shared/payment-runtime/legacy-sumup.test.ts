import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { promoteLegacySumupPayment } from "#shared/payment-runtime/legacy-sumup.ts";
import { createLegacySumupCheckout } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("legacy SumUp promotion", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("promotes encrypted legacy runtime through one current aggregate", async () => {
    const reference = "legacy-local-reference";
    await createLegacySumupCheckout(reference, "sumup-checkout-legacy");

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
