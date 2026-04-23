import { afterEach, beforeEach, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { SettingsData } from "#lib/db/settings.ts";
import { settings } from "#lib/db/settings.ts";

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
  const { settings: s } = await import("#lib/db/settings.ts");
  await s.update.stripe.secretKey(key);
  await s.update.paymentProvider("stripe");
};

export const stubWebhookVerify = async (eventData: {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}) => {
  const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
  return stub(stripePaymentProvider, "verifyWebhookSignature", () =>
    Promise.resolve({ event: eventData, valid: true as const }),
  );
};
