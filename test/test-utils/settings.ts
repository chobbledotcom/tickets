import { afterEach, beforeEach, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { SettingsData } from "#shared/db/settings.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";

/**
 * Seed the site country directly in the database for a test.
 *
 * Country is write-once in the app (chosen at /setup, with no runtime updater),
 * so tests can't go through a `settings.update.*` setter. This writes the raw
 * row and drops the cached snapshot, so the next `loadKeys`/request re-derives
 * currency, timezone, and phone prefix from it via the production load path.
 */
export const seedCountry = async (code: string): Promise<void> => {
  await settings.setRaw(CONFIG_KEYS.COUNTRY, code);
  settings.invalidateCache();
};

export const withSetting = async <T>(
  overrides: Partial<SettingsData>,
  fn: () => T | Promise<T>,
): Promise<T> => {
  settings.setForTest(overrides);
  try {
    return await fn();
  } finally {
    settings.clearTestOverride(
      ...(Object.keys(overrides) as (keyof SettingsData)[]),
    );
  }
};

export const useSetting = (overrides: Partial<SettingsData>): void => {
  const keys = Object.keys(overrides) as (keyof SettingsData)[];
  beforeEach(() => {
    settings.setForTest(overrides);
  });
  afterEach(() => {
    settings.clearTestOverride(...keys);
  });
};

export const testWithSetting = (
  name: string,
  overrides: Partial<SettingsData>,
  fn: () => void | Promise<void>,
): void => {
  it(name, () => withSetting(overrides, fn));
};

export const setupStripe = async (key = "sk_test_mock"): Promise<void> => {
  const { settings: s } = await import("#shared/db/settings.ts");
  await s.update.stripe.secretKey(key);
  await s.update.paymentProvider("stripe");
};

export const stubWebhookVerify = async (listingData: {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}) => {
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  return stub(stripePaymentProvider, "verifyWebhookSignature", () =>
    Promise.resolve({ listing: listingData, valid: true as const }),
  );
};
