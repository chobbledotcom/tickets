import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Spy } from "@std/testing/mock";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import {
  getActivePaymentProvider,
  getPaymentProviderForExistingPayments,
} from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { useDebugLogSpy } from "#test-utils/debug-log.ts";

/** True if any captured debug log line includes `needle`. The spy is
 *  per-describe (each describe owns its own `useDebugLogSpy` hooks). */
const debugLogged = (spy: () => Spy, needle: string): boolean =>
  spy().calls.some((call) => String(call.args[0]).includes(needle));

describeWithEnv("getActivePaymentProvider", { db: true }, () => {
  const debugSpy = useDebugLogSpy();

  test("returns null when no provider is configured", async () => {
    expect(await getActivePaymentProvider()).toBeNull();
    expect(
      debugLogged(
        debugSpy,
        "[Payment] No payment provider configured in settings",
      ),
    ).toBe(true);
  });

  test("logs the provider it resolves under the Payment category", async () => {
    await settings.update.paymentProvider("stripe");
    await getActivePaymentProvider();
    expect(
      debugLogged(debugSpy, "[Payment] Resolving payment provider: stripe"),
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

describeWithEnv("getPaymentProviderForExistingPayments", { db: true }, () => {
  const debugSpy = useDebugLogSpy();

  test("returns null when no provider was ever configured", async () => {
    expect(await getPaymentProviderForExistingPayments()).toBeNull();
  });

  test("returns the active provider when new sales are on", async () => {
    await settings.update.paymentProvider("stripe");
    expect((await getPaymentProviderForExistingPayments())?.type).toBe(
      "stripe",
    );
    expect(
      debugLogged(
        debugSpy,
        "Resolving payment provider for existing payments: stripe",
      ),
    ).toBe(true);
  });

  test("falls back to the last activated provider when new sales are off", async () => {
    await settings.update.paymentProvider("stripe");
    await settings.update.setPaymentProviderNone();
    // New sales are off, but the Stripe provider still resolves so existing
    // payments can be refunded, reconciled, and completed.
    expect(settings.paymentProvider).toBeNull();
    expect((await getPaymentProviderForExistingPayments())?.type).toBe(
      "stripe",
    );
    expect(
      debugLogged(
        debugSpy,
        "Resolving payment provider for existing payments: stripe",
      ),
    ).toBe(true);
  });

  test("returns null when sales are off and no provider was ever activated", async () => {
    await settings.update.setPaymentProviderNone();
    expect(await getPaymentProviderForExistingPayments()).toBeNull();
  });

  test("recovers from a pre-existing none site with exactly one set of credentials", async () => {
    // A site that was already on "none" before this PR: no payment_provider,
    // no last_active_payment_provider, but Stripe credentials are stored.
    // The resolver must fall back to the single configured provider.
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
    await settings.update.stripe.secretKey("sk_test_recovered");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    expect(settings.paymentProvider).toBeNull();
    expect(settings.lastActivePaymentProvider).toBeNull();
    expect((await getPaymentProviderForExistingPayments())?.type).toBe(
      "stripe",
    );
  });

  test("does not guess when multiple providers have stored credentials", async () => {
    // A pre-existing none site with both Stripe and Square credentials: the
    // resolver must not guess between them; the operator must re-select.
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
    await settings.update.stripe.secretKey("sk_test_both");
    await settings.update.square.accessToken("sq_test_both");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    expect(await getPaymentProviderForExistingPayments()).toBeNull();
  });

  test("throws when the current provider setting is corrupt", async () => {
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "broken-provider");
    await settings.update.stripe.secretKey("sk_test_stored");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "stripe");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    await expect(getPaymentProviderForExistingPayments()).rejects.toThrow(
      "Invalid payment_provider setting: broken-provider",
    );
  });

  test("recovers when sumup is the sole configured provider", async () => {
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
    await settings.update.sumup.apiKey("sumup_test_only");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    expect((await getPaymentProviderForExistingPayments())?.type).toBe("sumup");
  });
});
