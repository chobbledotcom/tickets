import { afterEach, beforeEach, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { SettingsData } from "#shared/db/settings.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { describeWithEnv } from "./db.ts";
import { withMocks } from "./mocks.ts";

/** The standard outer describe for admin-settings tests: scoped to
 *  `"server (admin settings)"` with a fresh test DB per spec and an
 *  `afterEach` that reverts any in-test demo-mode toggle. The
 *  `test/lib/server-settings/*.test.ts` files all live under this umbrella —
 *  hoisting the wrapper here keeps the per-setting files focused on the
 *  behaviour they exercise instead of re-stating the same scaffold. */
export const describeAdminSettings = (body: () => void): void =>
  describeWithEnv("server (admin settings)", { db: true }, () => {
    afterEach(() => {
      setDemoModeForTest(false);
    });
    body();
  });

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

/** Store one internally consistent Stripe API key and webhook pair, and select Stripe. */
export const activateStripe = (
  webhookSecret: string,
  webhookEndpointId = "we_test_endpoint",
  secretKey = "sk_test_mock",
): Promise<void> =>
  settings.update.stripe.activate({
    secretKey,
    webhookEndpointId,
    webhookSecret,
  });

/** Run `body` with Stripe webhook setup and old-endpoint cleanup succeeding. */
export const withSuccessfulStripeWebhook = async (
  body: () => void | Promise<void>,
): Promise<void> => {
  const { stripeApi } = await import("#shared/stripe.ts");
  await withMocks(
    () => ({
      cleanupStub: stub(stripeApi, "cleanupOldWebhookEndpoints", () =>
        Promise.resolve(),
      ),
      setupStub: stub(stripeApi, "setupWebhookEndpoint", () =>
        Promise.resolve({
          endpointId: "we_test_123",
          secret: "whsec_test_secret",
          success: true,
        }),
      ),
    }),
    body,
  );
};

/** Turn the public JSON API on for the current test DB. The single source of
 *  the `showPublicApi(true)` toggle that opens nearly every `/api/listings`
 *  test — hoisted so each test just states the precondition, not the import +
 *  setter dance behind it. The suite-level `afterEach` in
 *  {@link describeWithEnv} rolls the DB back, so the toggle never leaks. */
export const enablePublicApi = async (): Promise<void> => {
  const { settings: s } = await import("#shared/db/settings.ts");
  await s.update.showPublicApi(true);
};

/** Turn the public site on for the current test DB — mirrors
 *  {@link enablePublicApi} for the few tests that flip the site-visible
 *  toggle (e.g. `/listings` CTA suppression). */
export const enablePublicSite = async (): Promise<void> => {
  const { settings: s } = await import("#shared/db/settings.ts");
  await s.update.showPublicSite(true);
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
