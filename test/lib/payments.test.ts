import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { getActivePaymentProvider } from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("getActivePaymentProvider", { db: true }, () => {
  test("returns null when no provider is configured", async () => {
    expect(await getActivePaymentProvider()).toBeNull();
  });

  test("returns null for a provider type the module doesn't recognise", async () => {
    // setRaw bypasses the typed API; reload so the snapshot reflects the raw value
    await settings.setRaw("payment_provider", "unknown_provider");
    settings.invalidateCache();
    await settings.loadAll();
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
