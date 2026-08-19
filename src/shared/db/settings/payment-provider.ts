/**
 * The payment provider choice, and each provider's stored credentials.
 *
 * Two settings rows answer two different questions: which provider takes new
 * sales, and which provider owns the payments that already exist. The two rows
 * must agree, so every change writes both of them in one statement.
 *
 * The getters merge onto the `settings` namespace. The writers spread onto
 * `settings.update`.
 */

import * as v from "valibot";

import { encrypt } from "#shared/crypto/encryption.ts";
import { executeWithoutCacheInvalidation } from "#shared/db/client.ts";
import { boolUpdate, rawUpdate } from "#shared/db/settings/accessors.ts";
import { keyModeOf } from "#shared/db/settings/constants.ts";
import { withProperties } from "#shared/db/settings/namespace.ts";
import {
  deleteRaw,
  encryptedUpdate,
  plaintextUpdate,
  syncStoredSetting,
  writeRawBatch,
} from "#shared/db/settings/raw-writes.ts";
import { data, snap } from "#shared/db/settings/snapshot.ts";
import { PAYMENT_PROVIDER_IDS } from "#shared/payment-providers.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import type {
  PaymentProviderSetting,
  PaymentProviderType,
} from "#shared/types.ts";
import {
  isPaymentProvider,
  PaymentProviderSettingSchema,
} from "#shared/types.ts";

/** The card-provider getters shared by Stripe and SumUp: whether a secret key
 * is set, and whether that key is a test or live key. `keyName` is the setting
 * the provider's secret is stored under. */
const providerKeyStatus = (keyName: "stripe_secret_key" | "sumup_api_key") => ({
  get hasKey(): boolean {
    return snap(keyName) !== "";
  },
  get keyMode(): "test" | "live" | null {
    return keyModeOf(snap(keyName));
  },
});

/** Store the new-sales choice and the provider for existing payments together. */
const setPaymentProviderSnapshot = (active: PaymentProviderSetting): void => {
  data.payment_provider = active === "none" ? null : active;
  data.payment_provider_setting = active;
};

const syncReturnedPaymentProvider = (active: PaymentProviderSetting): void => {
  syncStoredSetting(CONFIG_KEYS.PAYMENT_PROVIDER, (values) =>
    values.set(CONFIG_KEYS.PAYMENT_PROVIDER, active),
  );
  setPaymentProviderSnapshot(active);
};

const syncLastActivePaymentProvider = (provider: string): void => {
  syncStoredSetting(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, (values) =>
    values.set(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, provider),
  );
  data.last_active_payment_provider = provider;
};

const changePaymentProvider = async (
  kind: "activate" | "credentials" | "disable" | "recover",
  provider?: PaymentProviderType,
  first = false,
): Promise<void> => {
  if (kind !== "disable" && (!provider || !isPaymentProvider(provider))) {
    throw new Error(`Invalid payment provider: ${provider}`);
  }
  const chosen = provider ?? "";
  const firstCredential = kind === "credentials" && first ? 1 : 0;
  const sql = `INSERT INTO settings (key, value) SELECT key, value FROM (
SELECT 'payment_provider' AS key, CASE WHEN ? IN ('disable', 'recover') THEN 'none' WHEN ? = 'credentials' THEN CASE WHEN (SELECT value FROM settings WHERE key = 'payment_provider') = ? OR (? = 1 AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'payment_provider')) THEN ? ELSE COALESCE((SELECT value FROM settings WHERE key = 'payment_provider'), 'none') END ELSE ? END AS value
UNION ALL SELECT 'last_active_payment_provider', CASE WHEN ? = 'disable' THEN CASE WHEN (SELECT value FROM settings WHERE key = 'payment_provider') IN (${PAYMENT_PROVIDER_IDS.map(() => "?").join(", ")}) THEN (SELECT value FROM settings WHERE key = 'payment_provider') ELSE COALESCE((SELECT value FROM settings WHERE key = 'last_active_payment_provider'), '') END WHEN ? = 'credentials' THEN CASE WHEN (SELECT value FROM settings WHERE key = 'payment_provider') = ? OR (? = 1 AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'payment_provider')) THEN ? ELSE COALESCE((SELECT value FROM settings WHERE key = 'last_active_payment_provider'), '') END ELSE ? END
UNION ALL SELECT 'settings_version', CAST(COALESCE((SELECT value FROM settings WHERE key = 'settings_version'), '0') AS INTEGER) + 1) WHERE (? <> 'recover' OR (COALESCE((SELECT value FROM settings WHERE key = 'payment_provider'), 'none') = 'none' AND COALESCE((SELECT value FROM settings WHERE key = 'last_active_payment_provider'), '') = '' AND EXISTS (SELECT 1 FROM settings WHERE key = CASE ? WHEN 'stripe' THEN ? WHEN 'square' THEN ? WHEN 'sumup' THEN ? END AND value <> '')))
AND (? <> 'activate' OR NOT (COALESCE((SELECT value FROM settings WHERE key = 'payment_provider'), 'none') = 'none' AND COALESCE((SELECT value FROM settings WHERE key = 'last_active_payment_provider'), '') = '' AND (SELECT COUNT(*) FROM settings WHERE key IN (?, ?, ?) AND value <> '') > 1))
ON CONFLICT(key) DO UPDATE SET value = excluded.value RETURNING key, value`;
  const credentialKeys = [
    CONFIG_KEYS.STRIPE_SECRET_KEY,
    CONFIG_KEYS.SQUARE_ACCESS_TOKEN,
    CONFIG_KEYS.SUMUP_API_KEY,
  ];
  const args = [
    [kind, kind, chosen, firstCredential, chosen, chosen, kind],
    PAYMENT_PROVIDER_IDS,
    [kind, chosen, firstCredential, chosen, chosen, kind, chosen],
    credentialKeys,
    [kind],
    credentialKeys,
  ].flat();
  const result = await executeWithoutCacheInvalidation(sql, args);
  const rejection =
    kind === "recover"
      ? "Payment provider recovery is no longer available"
      : "Choose the provider for existing payments before enabling new sales";
  if (result.rows.length === 0) {
    throw new Error(rejection);
  }
  const values = Object.fromEntries(
    result.rows.map((row) => [String(row.key), String(row.value)]),
  );
  syncReturnedPaymentProvider(
    v.parse(PaymentProviderSettingSchema, values[CONFIG_KEYS.PAYMENT_PROVIDER]),
  );
  syncLastActivePaymentProvider(
    v.parse(v.string(), values[CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER]),
  );
};

/** Sync reads — which provider is live, and what each one has stored. */
const getters = {
  /** Keeps existing-payment work available while new sales are off. */
  get lastActivePaymentProvider(): PaymentProviderType | null {
    const value = snap("last_active_payment_provider");
    if (value === "") return null;
    if (isPaymentProvider(value)) return value;
    throw new Error(`Invalid last_active_payment_provider setting: ${value}`);
  },
  get paymentProvider(): PaymentProviderType | null {
    return snap("payment_provider");
  },
  get paymentProviderSetting(): PaymentProviderSetting | null {
    return snap("payment_provider_setting");
  },

  // --- Square ---
  square: {
    get accessToken(): string {
      return snap("square_access_token");
    },
    get hasToken(): boolean {
      return snap("square_access_token") !== "";
    },
    get locationId(): string {
      return snap("square_location_id");
    },
    get sandbox(): boolean {
      return snap("square_sandbox");
    },
    get webhookSignatureKey(): string {
      return snap("square_webhook_signature_key");
    },
  },

  // --- Stripe ---
  stripe: withProperties(
    {
      get secretKey(): string {
        return snap("stripe_secret_key");
      },
      get webhookEndpointId(): string {
        return snap("stripe_webhook_endpoint_id");
      },
      get webhookSecret(): string {
        return snap("stripe_webhook_secret");
      },
    },
    providerKeyStatus("stripe_secret_key"),
  ),

  // --- SumUp ---
  sumup: withProperties(
    {
      get apiKey(): string {
        return snap("sumup_api_key");
      },
      get merchantCode(): string {
        return snap("sumup_merchant_code");
      },
    },
    providerKeyStatus("sumup_api_key"),
  ),
};

/** Async writes — the provider choice, and each provider's credentials. */
const updaters = {
  clearPaymentProvider: async (): Promise<void> => {
    await deleteRaw(CONFIG_KEYS.PAYMENT_PROVIDER);
    data.payment_provider = null;
    data.payment_provider_setting = null;
  },
  paymentProvider: async (v: PaymentProviderType): Promise<void> => {
    await changePaymentProvider("activate", v);
  },
  paymentProviderAfterCredentialSave: async (
    provider: PaymentProviderType,
    activateFromMissing: boolean,
  ): Promise<void> => {
    await changePaymentProvider("credentials", provider, activateFromMissing);
  },
  recoverPaymentProvider: async (v: PaymentProviderType): Promise<void> => {
    await changePaymentProvider("recover", v);
  },
  setPaymentProviderNone: async (): Promise<void> => {
    await changePaymentProvider("disable");
  },

  // --- Square writes ---
  square: {
    accessToken: encryptedUpdate(CONFIG_KEYS.SQUARE_ACCESS_TOKEN),
    locationId: rawUpdate(CONFIG_KEYS.SQUARE_LOCATION_ID, "square_location_id"),
    sandbox: boolUpdate(CONFIG_KEYS.SQUARE_SANDBOX, "square_sandbox"),
    webhookSignatureKey: encryptedUpdate(
      CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
    ),
  },
  // --- Stripe writes ---
  stripe: {
    configure: async (config: {
      secretKey: string;
      webhookSecret: string;
      webhookEndpointId: string;
    }): Promise<void> => {
      // The API key and webhook pair belong to one Stripe account. Save all
      // three together so a failed write leaves the prior credentials usable.
      await writeRawBatch([
        [CONFIG_KEYS.STRIPE_SECRET_KEY, await encrypt(config.secretKey)],
        [
          CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
          await encrypt(config.webhookSecret),
        ],
        [CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID, config.webhookEndpointId],
      ]);
      data.stripe_secret_key = config.secretKey;
      data.stripe_webhook_secret = config.webhookSecret;
      data.stripe_webhook_endpoint_id = config.webhookEndpointId;
    },
    secretKey: encryptedUpdate(CONFIG_KEYS.STRIPE_SECRET_KEY),
  },
  // --- SumUp writes ---
  sumup: {
    apiKey: encryptedUpdate(CONFIG_KEYS.SUMUP_API_KEY),
    merchantCode: plaintextUpdate(CONFIG_KEYS.SUMUP_MERCHANT_CODE),
  },
};

/** The provider getters to merge onto `settings`, and the writers to spread
 *  onto `settings.update`. */
export const paymentProviderAccessors = { getters, updaters };
