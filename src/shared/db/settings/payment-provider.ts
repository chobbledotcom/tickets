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

import { encrypt } from "#crypto/encryption.ts";
import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { boolUpdate, rawUpdate } from "#db/settings/accessors.ts";
import { keyModeOf } from "#db/settings/constants.ts";
import { withProperties } from "#db/settings/namespace.ts";
import {
  deleteRaw,
  encryptedUpdate,
  plaintextUpdate,
  syncStoredSetting,
  writeRawBatch,
} from "#db/settings/raw-writes.ts";
import { data, snap } from "#db/settings/snapshot.ts";
import { PAYMENT_PROVIDER_IDS } from "#shared/payment-providers.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import {
  isPaymentProvider,
  type PaymentProviderSetting,
  PaymentProviderSettingSchema,
  type PaymentProviderType,
} from "#types";

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

/** Where each provider keeps its own credential. An exhaustive record, so a
 * fourth provider is a compile error here rather than a silent miss. */
const CREDENTIAL_KEY_OF: Record<PaymentProviderType, string> = {
  square: CONFIG_KEYS.SQUARE_ACCESS_TOKEN,
  stripe: CONFIG_KEYS.STRIPE_SECRET_KEY,
  sumup: CONFIG_KEYS.SUMUP_API_KEY,
};

/** Credential keys in the same order as the provider ids, so slot N of one
 * lines up with slot N of the other. */
const CREDENTIAL_KEYS = PAYMENT_PROVIDER_IDS.map((id) => CREDENTIAL_KEY_OF[id]);

/** Numbered parameters, so a value the statement reads seven times is still
 * bound once. The slots run in the order `changePaymentProvider` passes them:
 * the kind of change, the provider it names, whether this is a first
 * credential save, the credential key of the provider it names, then one slot
 * per provider id and one per credential key. */
const slot = (index: number): string => `?${index + 1}`;
const KIND = slot(0);
const CHOSEN = slot(1);
const FIRST_CREDENTIAL = slot(2);
const CHOSEN_CREDENTIAL_KEY = slot(3);
const PROVIDER_ID_SLOTS = PAYMENT_PROVIDER_IDS.map((_, i) => slot(4 + i));
const CREDENTIAL_KEY_SLOTS = CREDENTIAL_KEYS.map((_, i) =>
  slot(4 + PAYMENT_PROVIDER_IDS.length + i),
);

/** What the two rows hold right now. A row that does not exist yet reads as
 * "no provider takes sales" and "none is remembered". */
const STORED_PROVIDER = `(SELECT value FROM settings WHERE key = 'payment_provider')`;
const STORED_LAST_ACTIVE = `(SELECT value FROM settings WHERE key = 'last_active_payment_provider')`;
const CURRENT_PROVIDER = `COALESCE(${STORED_PROVIDER}, 'none')`;
const CURRENT_LAST_ACTIVE = `COALESCE(${STORED_LAST_ACTIVE}, '')`;

/** A credential save speaks for the provider it names only when that provider
 * is already the chosen one, or when it is the first credential on a site that
 * has never chosen. Otherwise a stale save cannot replace a newer choice. */
const CREDENTIAL_SAVE_WINS = `${STORED_PROVIDER} = ${CHOSEN}
          OR (
            ${FIRST_CREDENTIAL} = 1
            AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'payment_provider')
          )`;

/** No provider takes new sales, and none is remembered for the payments that
 * already exist. Both recovery and activation turn on this state. */
const NOTHING_CHOSEN_YET = `${CURRENT_PROVIDER} = 'none'
      AND ${CURRENT_LAST_ACTIVE} = ''`;

/** Which provider takes new sales after this change. */
const NEW_PROVIDER = `CASE
      WHEN ${KIND} IN ('disable', 'recover') THEN 'none'
      WHEN ${KIND} = 'credentials' THEN CASE
        WHEN ${CREDENTIAL_SAVE_WINS} THEN ${CHOSEN}
        ELSE ${CURRENT_PROVIDER}
      END
      ELSE ${CHOSEN}
    END`;

/** Which provider owns the payments that already exist. Switching sales off
 * remembers the provider that was live, so refunds keep working. */
const NEW_LAST_ACTIVE = `CASE
      WHEN ${KIND} = 'disable' THEN CASE
        WHEN ${STORED_PROVIDER} IN (${PROVIDER_ID_SLOTS.join(", ")})
          THEN ${STORED_PROVIDER}
        ELSE ${CURRENT_LAST_ACTIVE}
      END
      WHEN ${KIND} = 'credentials' THEN CASE
        WHEN ${CREDENTIAL_SAVE_WINS} THEN ${CHOSEN}
        ELSE ${CURRENT_LAST_ACTIVE}
      END
      ELSE ${CHOSEN}
    END`;

/** Every settings write bumps the version, which is what invalidates the
 * per-request snapshot. */
const NEXT_VERSION = `CAST(
      COALESCE((SELECT value FROM settings WHERE key = 'settings_version'), '0') AS INTEGER
    ) + 1`;

/** Recovery is only for a site that lost its choice and still holds the named
 * provider's credential. Nothing else qualifies for it. */
const RECOVERY_ALLOWED = `${KIND} <> 'recover' OR (
      ${NOTHING_CHOSEN_YET}
      AND EXISTS (
        SELECT 1 FROM settings
        WHERE key = ${CHOSEN_CREDENTIAL_KEY}
        AND value <> ''
      )
    )`;

/** Turning sales on is ambiguous when nothing is chosen and more than one
 * provider holds credentials. The owner recovers the old provider first. */
const ACTIVATION_ALLOWED = `${KIND} <> 'activate' OR NOT (
      ${NOTHING_CHOSEN_YET}
      AND (
        SELECT COUNT(*) FROM settings
        WHERE key IN (${CREDENTIAL_KEY_SLOTS.join(", ")}) AND value <> ''
      ) > 1
    )`;

/** One statement decides both provider rows and bumps the version, so a
 * concurrent change cannot land between reading the current provider and
 * writing the new one. It returns no rows when a guard refuses the change. */
const CHANGE_PROVIDER_SQL = `INSERT INTO settings (key, value)
  SELECT key, value FROM (
    SELECT 'payment_provider' AS key, ${NEW_PROVIDER} AS value
    UNION ALL SELECT 'last_active_payment_provider', ${NEW_LAST_ACTIVE}
    UNION ALL SELECT 'settings_version', ${NEXT_VERSION}
  )
  WHERE (${RECOVERY_ALLOWED})
  AND (${ACTIVATION_ALLOWED})
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
  RETURNING key, value`;

const changePaymentProvider = async (
  kind: "activate" | "credentials" | "disable" | "recover",
  provider?: PaymentProviderType,
  first?: boolean,
): Promise<void> => {
  if (kind !== "disable" && (!provider || !isPaymentProvider(provider))) {
    throw new Error(`Invalid payment provider: ${provider}`);
  }
  const chosen = provider ?? "";
  const firstCredential = kind === "credentials" && first ? 1 : 0;
  // Empty only when the change names no provider, which is switching sales
  // off — and that path never reads the key.
  const chosenCredentialKey = provider ? CREDENTIAL_KEY_OF[provider] : "";
  const args = [
    kind,
    chosen,
    firstCredential,
    chosenCredentialKey,
    ...PAYMENT_PROVIDER_IDS,
    ...CREDENTIAL_KEYS,
  ];
  const result = await executeWithoutCacheInvalidation(
    CHANGE_PROVIDER_SQL,
    args,
  );
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
