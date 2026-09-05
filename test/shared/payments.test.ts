import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import {
  getActivePaymentProvider,
  getPaymentProviderForExistingPayments,
} from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { logLogged, useDebugLogSpy } from "#test-utils/debug-log.ts";

describeWithEnv("getActivePaymentProvider", { db: true }, () => {
  const debugSpy = useDebugLogSpy();

  test("returns null when no provider is configured", async () => {
    expect(await getActivePaymentProvider()).toBeNull();
    expect(
      logLogged(
        debugSpy,
        "[Payment] No payment provider configured in settings",
      ),
    ).toBe(true);
  });

  test("logs the provider it resolves under the Payment category", async () => {
    await settings.update.paymentProvider("stripe");
    await getActivePaymentProvider();
    expect(
      logLogged(debugSpy, "[Payment] Resolving payment provider: stripe"),
    ).toBe(true);
  });

  test("labels a provider resolved for existing payments", async () => {
    await settings.update.stripe.secretKey("sk_test_existing_label");
    await settings.update.paymentProvider("stripe");
    await getPaymentProviderForExistingPayments();
    expect(
      logLogged(
        debugSpy,
        "[Payment] Resolving payment provider for existing payments: stripe",
      ),
    ).toBe(true);
  });

  test("returns null for a provider type the module doesn't recognise", async () => {
    // setRaw bypasses the typed API; reload so the snapshot reflects the raw value
    await settings.setRaw("payment_provider", "unknown_provider");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    expect(await getActivePaymentProvider()).toBeNull();
  });

  test("returns the stripe provider when provider is set to stripe", async () => {
    await settings.update.paymentProvider("stripe");
    const provider = await getActivePaymentProvider();
    expect(provider?.type).toBe("stripe");
  });

  test("returns the square provider when provider is set to square", async () => {
    await settings.update.paymentProvider("square");
    const provider = await getActivePaymentProvider();
    expect(provider?.type).toBe("square");
  });

  test("returns the sumup provider when provider is set to sumup", async () => {
    await settings.update.paymentProvider("sumup");
    const provider = await getActivePaymentProvider();
    expect(provider?.type).toBe("sumup");
  });
});
