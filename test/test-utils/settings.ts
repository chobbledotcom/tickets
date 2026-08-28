import { afterEach, beforeEach, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setAdminFeatureEnabled } from "#db/admin-features.ts";
import { execute, executeBatch, queryOne } from "#db/client.ts";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  type SettingsData,
  settings,
} from "#db/settings.ts";
import {
  type AdminFeatureKey,
  type EnabledFeatures,
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { describeWithEnv } from "./db.ts";
import { withMocks } from "./mocks.ts";

/** Read every setting back off disk, throwing away what this process last
 * cached. A test that saved through a route and then asks what the site holds
 * has to cross that boundary, or it reads its own stale snapshot back. */
export const settingsAsStored = async (): Promise<void> => {
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
};

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

export const featureSetting = (
  ...enabled: AdminFeatureKey[]
): Pick<SettingsData, "enabled_features"> => ({
  enabled_features: serializeEnabledFeatures(
    enabled.reduce(
      (features, key) => setFeatureEnabled(features, key, true),
      parseEnabledFeatures(""),
    ),
  ),
});

export const enableFeature = async (key: AdminFeatureKey): Promise<void> => {
  await setAdminFeatureEnabled(key, true);
};

export const settingValue = async (key: string): Promise<string> => {
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  if (!row) throw new Error(`Setting ${key} was not stored`);
  return row.value;
};

export const storedFeatureEnabled = async (
  key: AdminFeatureKey,
): Promise<boolean> =>
  parseEnabledFeatures(await settingValue(CONFIG_KEYS.ENABLED_FEATURES))[key];

/** One saved modifier, which is what puts the Modifiers feature in use. Every
 * test that needs that state writes this same row, so it is written once. */
const MODIFIER_SQL =
  "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES (?, 'fixed', 1, 'increase')";

export const saveAModifier = (name = "Fee"): Promise<unknown> =>
  execute(MODIFIER_SQL, [name]);

export const seedFeatureRecords = (includeLogistics = true): Promise<void> =>
  executeBatch([
    ...[
      "INSERT INTO attributes (name) VALUES ('Level')",
      "INSERT INTO questions (text, display_type) VALUES ('Notes?', 'free_text')",
      ...(includeLogistics
        ? ["INSERT INTO logistics_agents (name) VALUES ('Delivery team')"]
        : []),
      "INSERT INTO api_keys (user_id, key_index, wrapped_data_key, name, created) VALUES (1, 'index', 'key', 'Sync', '2026-07-15')",
      "INSERT INTO attendees (created, kind) VALUES ('2026-07-15', 'servicing')",
    ].map((sql) => ({ args: [], sql })),
    { args: ["Fee"], sql: MODIFIER_SQL },
  ]);

export const SEEDED_FEATURE_RECORDS: EnabledFeatures = {
  apiKeys: true,
  attributes: true,
  logistics: true,
  modifiers: true,
  money: false,
  questions: true,
  servicing: true,
  site: false,
};

/** Run an action while every attempt to persist the feature setting fails. */
export const withFeatureWriteFailure = async <T>(
  run: () => Promise<T>,
): Promise<T> => {
  await execute(`
    CREATE TRIGGER fail_feature_write
    BEFORE INSERT ON settings
    WHEN NEW.key = '${CONFIG_KEYS.ENABLED_FEATURES}'
    BEGIN
      SELECT RAISE(ABORT, 'feature enable failed');
    END
  `);
  try {
    return await run();
  } finally {
    await execute("DROP TRIGGER IF EXISTS fail_feature_write");
  }
};

export const testWithSetting = (
  name: string,
  overrides: Partial<SettingsData>,
  fn: () => void | Promise<void>,
): void => {
  it(name, () => withSetting(overrides, fn));
};

export const setupStripe = async (key = "sk_test_mock"): Promise<void> => {
  const { settings: s } = await import("#db/settings.ts");
  await s.update.stripe.secretKey(key);
  await s.update.paymentProvider("stripe");
};

/** Set up the ambiguous sales-off state that asks an operator which provider
 * took existing payments. */
export const requirePaymentProviderRecovery = async (): Promise<void> => {
  await settings.update.stripe.secretKey("sk_test_provider_recovery");
  await settings.update.square.accessToken("square-provider-recovery");
  await settings.update.setPaymentProviderNone();
  await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
  settings.invalidateCache();
  await settings.loadKeys([
    CONFIG_KEYS.PAYMENT_PROVIDER,
    CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER,
    CONFIG_KEYS.STRIPE_SECRET_KEY,
    CONFIG_KEYS.SQUARE_ACCESS_TOKEN,
  ]);
};

/** Store one internally consistent Stripe API key and webhook pair, and select Stripe. */
export const activateStripe = async (
  webhookSecret: string,
  webhookEndpointId = "we_test_endpoint",
  secretKey = "sk_test_mock",
): Promise<void> => {
  await settings.update.stripe.configure({
    secretKey,
    webhookEndpointId,
    webhookSecret,
  });
  await settings.update.paymentProvider("stripe");
};

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
  const { settings: s } = await import("#db/settings.ts");
  await s.update.showPublicApi(true);
};

/** Turn the Site feature on for the current test DB. */
export const enablePublicSite = async (): Promise<void> => {
  await enableFeature("site");
};

/** The address the site both sends from and delivers contact messages to. */
export const CONTACT_OWNER_EMAIL = "owner@example.com";

/** Point the site's email at the stand-in provider, so every kind of message
 * the site sends — contact, support, bulk — shares one set-up. The key is
 * never checked; only that a provider is configured. */
export const connectResendProvider = async (): Promise<void> => {
  await settings.update.email.provider("resend");
  await settings.update.email.apiKey("re_test_key");
};

/** Everything the public contact form needs before anybody can use it. Shared
 * by the story and the direct tests so the two can never drift into checking
 * different set-ups. */
export const activateContactForm = async (): Promise<void> => {
  await enablePublicSite();
  await settings.update.businessEmail(CONTACT_OWNER_EMAIL);
  await settings.update.contactFormEnabled(true);
  await connectResendProvider();
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
