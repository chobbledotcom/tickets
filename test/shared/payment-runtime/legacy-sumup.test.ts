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

  test("finds nothing for a reference no old checkout was kept under", async () => {
    expect(await promoteLegacySumupPayment("no-such-reference")).toBeNull();
  });

  test("refuses an old checkout that never recorded its SumUp id", async () => {
    // Without the SumUp id there is no way to ask SumUp about the payment, so
    // bringing it forward would lose the only link back to the money.
    const reference = "legacy-no-checkout-id";
    await createLegacySumupCheckout(reference, "");

    await expect(promoteLegacySumupPayment(reference)).rejects.toThrow(
      "has no checkout id",
    );
  });

  test("refuses an old checkout whose stored details nothing vouches for", async () => {
    // The details say what the buyer was asked to pay, and the price proof is
    // what makes them trustworthy. Without it we will not carry them forward.
    const reference = "legacy-unsigned-details";
    await createLegacySumupCheckout(reference, "sumup-unsigned", {
      unsigned: true,
    });

    await expect(promoteLegacySumupPayment(reference)).rejects.toThrow(
      "has invalid metadata",
    );
  });

  test("refuses two old checkouts that both never recorded a SumUp id", async () => {
    // There are two records to choose between and no id to name either of
    // them by, so the owner cannot even be told which checkout is in question.
    const reference = "legacy-two-without-ids";
    await createLegacySumupCheckout(reference, "", { filedUnder: "sumup" });
    await createLegacySumupCheckout(reference, "", { filedUnder: "session" });

    await expect(promoteLegacySumupPayment(reference)).rejects.toThrow(
      "Ambiguous legacy SumUp payments have no checkout id",
    );
  });
});
