import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import {
  paymentProviderHasCredentials,
  paymentProviderMode,
  paymentProviderUsesSandbox,
} from "#shared/payment-provider-status.ts";
import { PAYMENT_PROVIDER_IDS } from "#shared/payment-providers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("payment provider status", { db: true }, () => {
  test("reports no credentials for any provider on a fresh site", () => {
    for (const provider of PAYMENT_PROVIDER_IDS) {
      expect(paymentProviderHasCredentials(provider)).toBe(false);
    }
  });

  test("sees a stored Square token only for Square", async () => {
    await settings.update.square.accessToken("sq0atp-token");
    expect(paymentProviderHasCredentials("square")).toBe(true);
    expect(paymentProviderHasCredentials("stripe")).toBe(false);
    expect(paymentProviderHasCredentials("sumup")).toBe(false);
  });

  test("sees a stored Stripe key only for Stripe", async () => {
    await settings.update.stripe.secretKey("sk_test_key");
    expect(paymentProviderHasCredentials("stripe")).toBe(true);
    expect(paymentProviderHasCredentials("square")).toBe(false);
  });

  test("sees a stored SumUp key only for SumUp", async () => {
    await settings.update.sumup.apiKey("sk_test_key");
    expect(paymentProviderHasCredentials("sumup")).toBe(true);
    expect(paymentProviderHasCredentials("stripe")).toBe(false);
  });

  test("answers a mode for every provider, so no page shows a blank", () => {
    for (const provider of PAYMENT_PROVIDER_IDS) {
      expect(["live", "sandbox", "test", "unknown"]).toContain(
        paymentProviderMode(provider),
      );
    }
  });

  test("reads Square's estate from its sandbox switch", async () => {
    expect(paymentProviderMode("square")).toBe("live");
    await settings.update.square.sandbox(true);
    expect(paymentProviderMode("square")).toBe("sandbox");
    await settings.update.square.sandbox(false);
    expect(paymentProviderMode("square")).toBe("live");
  });

  test("reads a card provider's estate from the kind of key stored", async () => {
    expect(paymentProviderMode("stripe")).toBe("unknown");
    await settings.update.stripe.secretKey("sk_test_abc");
    expect(paymentProviderMode("stripe")).toBe("test");
    await settings.update.stripe.secretKey("sk_live_abc");
    expect(paymentProviderMode("stripe")).toBe("live");
  });

  test("reads SumUp's estate from the kind of key stored", async () => {
    expect(paymentProviderMode("sumup")).toBe("unknown");
    await settings.update.sumup.apiKey("sk_test_abc");
    expect(paymentProviderMode("sumup")).toBe("test");
  });

  test("reports an unknown estate for a key it cannot read", async () => {
    await settings.update.stripe.secretKey("rk_live_restricted");
    expect(paymentProviderMode("stripe")).toBe("unknown");
  });

  test("says a fresh site is not in any provider's sandbox", () => {
    for (const provider of PAYMENT_PROVIDER_IDS) {
      expect(paymentProviderUsesSandbox(provider)).toBe(false);
    }
  });

  test("follows Square's sandbox switch", async () => {
    await settings.update.square.sandbox(true);
    expect(paymentProviderUsesSandbox("square")).toBe(true);
    await settings.update.square.sandbox(false);
    expect(paymentProviderUsesSandbox("square")).toBe(false);
  });

  // Stripe and SumUp host one estate, so a test key talks to the live hosts.
  // Answering "yes" for either would point the security policy at origins
  // neither provider declares.
  test("says a card provider is never in a sandbox, whatever key is stored", async () => {
    await settings.update.stripe.secretKey("sk_test_abc");
    await settings.update.sumup.apiKey("sk_test_abc");
    await settings.update.square.sandbox(true);

    expect(paymentProviderUsesSandbox("stripe")).toBe(false);
    expect(paymentProviderUsesSandbox("sumup")).toBe(false);
  });
});
