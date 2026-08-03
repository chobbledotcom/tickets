import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { requirePaymentProvider } from "#routes/admin/require-provider.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("requirePaymentProvider", { db: true }, () => {
  test("returns the provider when one is configured", async () => {
    await settings.update.stripe.secretKey("sk_test_required");
    await settings.update.paymentProvider("stripe");
    const provider = await requirePaymentProvider(() =>
      Promise.resolve("missing" as const),
    );
    expect((provider as { type: string }).type).toBe("stripe");
  });

  test("falls back to the onMissing result when no provider is configured", async () => {
    const result = await requirePaymentProvider(() =>
      Promise.resolve("called-on-missing" as const),
    );
    expect(result).toBe("called-on-missing");
  });

  test("falls back to the last-active provider when sales are off", async () => {
    await settings.update.square.accessToken("square-required");
    await settings.update.paymentProvider("square");
    await settings.update.setPaymentProviderNone();
    const provider = await requirePaymentProvider(() =>
      Promise.resolve<string | null>(null),
    );
    expect((provider as { type: string }).type).toBe("square");
  });

  test("falls back to onMissing when sales are off and no provider was configured", async () => {
    await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
    await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
    settings.invalidateCache();
    await settings.loadKeys([
      CONFIG_KEYS.PAYMENT_PROVIDER,
      CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER,
    ]);
    const result = await requirePaymentProvider(() =>
      Promise.resolve("no-provider" as const),
    );
    expect(result).toBe("no-provider");
  });
});
