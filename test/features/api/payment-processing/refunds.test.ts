import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getPaymentProviderOrLog } from "#routes/api/payment-processing/refunds.ts";
import { ErrorCode } from "#shared/logger.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("getPaymentProviderOrLog", { db: true }, () => {
  const errors = setupErrorSpy();

  test("returns the configured provider when one is set", async () => {
    await setupStripe();
    const provider = await getPaymentProviderOrLog(
      ErrorCode.PAYMENT_REFUND,
      "refund lookup",
    );
    expect((provider as { type: string } | null)?.type).toBe("stripe");
  });

  test("returns null and logs when no provider is configured", async () => {
    const provider = await getPaymentProviderOrLog(
      ErrorCode.PAYMENT_REFUND,
      "no provider for refund",
    );
    expect(provider).toBeNull();
    expect(errors.contains("no provider for refund")).toBe(true);
  });
});
