import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { orderedCredentialedPaymentProviderTypes } from "#shared/existing-payment-provider.ts";
import { getPaymentProviderForExistingPayments } from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { debugLogged, useDebugLogSpy } from "#test-utils/debug-log.ts";

describeWithEnv("getPaymentProviderForExistingPayments", { db: true }, () => {
  const debugSpy = useDebugLogSpy();

  test("returns null when no provider was ever configured", async () => {
    expect(await getPaymentProviderForExistingPayments()).toBeNull();
  });

  test("returns the active provider when new sales are on", async () => {
    await settings.update.stripe.secretKey("sk_test_active");
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
    await settings.update.stripe.secretKey("sk_test_remembered");
    await settings.update.paymentProvider("stripe");
    await settings.update.setPaymentProviderNone();
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

  test("does not use a remembered provider whose credentials were removed", async () => {
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "stripe");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    expect(await getPaymentProviderForExistingPayments()).toBeNull();
  });

  test("does not use an active provider without credentials", async () => {
    await settings.update.paymentProvider("stripe");
    expect(await getPaymentProviderForExistingPayments()).toBeNull();
  });

  test("recovers from a sales-off site with one set of credentials", async () => {
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

  test("does not guess when several providers have credentials", async () => {
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
    await settings.update.stripe.secretKey("sk_test_both");
    await settings.update.square.accessToken("sq_test_both");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    expect(await getPaymentProviderForExistingPayments()).toBeNull();
  });

  test("throws when the current provider setting is corrupt", async () => {
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "mutated");
    await settings.update.stripe.secretKey("sk_test_stored");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "stripe");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    await expect(getPaymentProviderForExistingPayments()).rejects.toThrow(
      "Invalid payment_provider setting: mutated",
    );
  });

  test("recovers when SumUp is the sole configured provider", async () => {
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
    await settings.update.sumup.apiKey("sumup_test_only");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    expect((await getPaymentProviderForExistingPayments())?.type).toBe("sumup");
  });

  test("orders every credentialed provider behind the active provider", async () => {
    await settings.update.stripe.secretKey("sk_test_order");
    await settings.update.paymentProvider("stripe");
    await settings.update.square.accessToken("square_order");
    await settings.update.sumup.apiKey("sumup_order");

    expect(orderedCredentialedPaymentProviderTypes()).toEqual([
      "stripe",
      "square",
      "sumup",
    ]);
  });

  test("orders every credentialed provider behind the remembered provider", async () => {
    await settings.update.sumup.apiKey("sumup_remembered_order");
    await settings.update.paymentProvider("sumup");
    await settings.update.setPaymentProviderNone();
    await settings.update.square.accessToken("square_remembered_order");
    await settings.update.stripe.secretKey("sk_test_remembered_order");

    expect(orderedCredentialedPaymentProviderTypes()).toEqual([
      "sumup",
      "square",
      "stripe",
    ]);
  });

  test("uses registry order when several providers have no preferred one", async () => {
    await settings.update.square.accessToken("square_registry_order");
    await settings.update.stripe.secretKey("sk_test_registry_order");
    await settings.update.sumup.apiKey("sumup_registry_order");
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    expect(orderedCredentialedPaymentProviderTypes()).toEqual([
      "square",
      "stripe",
      "sumup",
    ]);
  });
});
