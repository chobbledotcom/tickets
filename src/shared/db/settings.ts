/**
 * Settings — sync reads, async writes.
 *
 * Call `settings.loadKeys(keys)` before a request to populate the snapshot.
 * After that, every setting is a plain sync property:
 *
 *   settings.theme            // "light"
 *   settings.headerImageUrl   // string
 *   settings.stripe.secretKey // string
 *
 * Writes go through `settings.update.*`:
 *
 *   await settings.update.theme("dark");
 *   await settings.update.headerImageUrl(url);
 *
 * This entry file assembles the {@link settings} namespace over the helpers
 * split across `./settings/`:
 *   - `settings/cache.ts`        — raw-row cache + version stamp
 *   - `settings/snapshot.ts`    — in-memory snapshot + `snap`/test overrides
 *   - `settings/raw-writes.ts`   — DB writers + encrypted/plaintext factories
 *   - `settings/accessors.ts`    — generated string getter/writer pairs
 *   - `settings/apply.ts`        — per-key snapshot appliers + key lists
 *   - `settings/load.ts`         — `loadKeys` + `invalidateCache`
 *   - `settings/setup.ts`        — setup-complete gate + initial site ceremony
 *   - `settings/password.ts`     — owner password re-wrap
 *   - `settings/current-task.ts` — single-flight `current_task` lock
 *   - `settings/mask.ts`         — `MASK_SENTINEL`/`isMaskSentinel`
 *   - `settings/constants.ts`   — `MAX_*_LENGTH` limits + `keyModeOf`
 */

import type { AddressLookupSetting } from "#shared/address-lookup/types.ts";
import { isAddressLookupSetting } from "#shared/address-lookup/types.ts";
import {
  type EnabledFeatures,
  parseEnabledFeatures,
} from "#shared/admin-features.ts";
import { encrypt } from "#shared/crypto/encryption.ts";
import {
  boolUpdate,
  rawUpdate,
  stringAccessors,
  timestampUpdate,
} from "#shared/db/settings/accessors.ts";
import {
  ALL_SETTINGS_KEYS,
  SNAPSHOT_KEYS,
  TEMPLATE_KEYS,
} from "#shared/db/settings/apply.ts";
import {
  bumpSettingsVersion,
  getCacheState,
  getCurrentSettingsVersion,
  prefetchVersion,
} from "#shared/db/settings/cache.ts";
import { keyModeOf } from "#shared/db/settings/constants.ts";
import { withCurrentTask } from "#shared/db/settings/current-task.ts";
import { invalidateCache, loadKeys } from "#shared/db/settings/load.ts";
import { updateUserPassword } from "#shared/db/settings/password.ts";
import {
  deleteRaw,
  encryptedUpdate,
  getRawCached,
  plaintextUpdate,
  writeEncrypted,
  writeOrDelete,
  writeRaw,
  writeRawBatch,
} from "#shared/db/settings/raw-writes.ts";
import {
  clearSetupCompleteCache,
  completeSetup,
  isSetupComplete,
} from "#shared/db/settings/setup.ts";
import {
  clearTestOverrides,
  data,
  getTestOverrides,
  type SettingsData,
  setSnapshotField,
  snap,
} from "#shared/db/settings/snapshot.ts";
import {
  type ListingDefaults,
  parseListingDefaults,
  serializeListingDefaults,
} from "#shared/listing-defaults.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { EMAIL_BODY_KEYS, PRUNE_KEYS } from "#shared/settings/registry.ts";
import type {
  EmailTemplateFormat,
  EmailTemplateType,
  PaymentProviderSetting,
  PaymentProviderType,
  SuperuserChoice,
  Theme,
} from "#shared/types.ts";
import { isSuperuserChoice } from "#shared/types.ts";
import { appleWallet } from "#shared/wallets/apple-wallet-settings.ts";
import { googleWallet } from "#shared/wallets/google-wallet-settings.ts";
import type { EmailContent } from "#templates/email/shared.ts";

export type { SettingsData };
export {
  ALL_SETTINGS_KEYS,
  bumpSettingsVersion,
  CONFIG_KEYS,
  EMAIL_BODY_KEYS,
  getCurrentSettingsVersion,
  PRUNE_KEYS,
  SNAPSHOT_KEYS,
};

/**
 * Copy property descriptors (preserving getters) from `props` onto `target`.
 * A spread would eagerly evaluate the getters instead.
 */
const withProperties = <T extends object, P extends object>(
  target: T,
  props: P,
): T & P => {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(props));
  return target as T & P;
};

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

const settingsBase = {
  // --- Address lookup ---
  addressLookup: {
    get apiKey(): string {
      return snap("address_lookup_api_key");
    },
    get hasKey(): boolean {
      return snap("address_lookup_api_key") !== "";
    },
    get provider(): AddressLookupSetting {
      const value = snap("address_lookup_provider");
      return isAddressLookupSetting(value) ? value : "none";
    },
  },
  // --- Apple Wallet ---
  appleWallet: appleWallet.createReadSettings(snap as (k: string) => string),
  get autoPurgeOrphans(): boolean {
    return snap("auto_purge_orphans");
  },
  get bookingFee(): string {
    return snap("booking_fee");
  },

  // -----------------------------------------------------------------------
  // Sync reads — all populated by loadKeys()
  // -----------------------------------------------------------------------

  get calendarFeedsEnabled(): boolean {
    return snap("calendar_feeds_enabled");
  },
  get calendarFeedsGroupBy(): "attendees" | "listings" {
    const value = snap("calendar_feeds_group_by");
    return value === "listings" ? "listings" : "attendees";
  },

  /** Remove specific test override keys (falls back to data). */
  clearTestOverride(...keys: (keyof SettingsData)[]): void {
    const current = getTestOverrides();
    for (const key of keys) {
      delete current[key];
    }
  },

  /** Clear all test overrides. */
  clearTestOverrides,

  get contactFormEnabled(): boolean {
    return snap("contact_form_enabled");
  },

  get country(): string {
    return snap("country");
  },

  // Derived from country
  get currency(): string {
    return snap("currency");
  },

  // --- Email ---
  email: {
    get apiKey(): string {
      return snap("email_api_key");
    },
    get fromAddress(): string {
      return snap("email_from_address");
    },
    get hasApiKey(): boolean {
      return snap("email_api_key") !== "";
    },
    get provider(): string {
      return snap("email_provider");
    },
    template(type: EmailTemplateType, format: EmailTemplateFormat): string {
      return snap(TEMPLATE_KEYS[`${type}:${format}`]);
    },
    templateSet(type: EmailTemplateType): EmailContent {
      return {
        html: this.template(type, "html"),
        subject: this.template(type, "subject"),
        text: this.template(type, "text"),
      };
    },
  },
  get externalOrderEnabled(): boolean {
    return snap("external_order_enabled");
  },

  get features(): EnabledFeatures {
    return parseEnabledFeatures(snap(CONFIG_KEYS.ENABLED_FEATURES));
  },
  /** Read a raw (possibly encrypted) value from the cache. */
  getCachedRaw: getRawCached,

  // --- Google Wallet ---
  googleWallet: googleWallet.createReadSettings(snap as (k: string) => string),
  invalidateCache,
  get listingDefaults(): ListingDefaults {
    return parseListingDefaults(snap(CONFIG_KEYS.LISTING_DEFAULTS));
  },
  // --- Core ---
  loadKeys,
  get orderEnabled(): boolean {
    return snap("order_enabled");
  },
  get orphanPurgeRetention(): string {
    return snap("orphan_purge_retention");
  },
  get paymentProvider(): PaymentProviderType | null {
    return snap("payment_provider");
  },
  get paymentProviderSetting(): PaymentProviderSetting | null {
    return snap("payment_provider_setting");
  },
  get phonePrefix(): string {
    return snap("phone_prefix");
  },
  /** Begin the per-request settings-version probe as early as possible. */
  prefetchVersion,

  /** Set test overrides (survive invalidateCache, cleared by clearTestOverrides). */
  setForTest(overrides: Partial<SettingsData>): void {
    const current = getTestOverrides();
    for (const [k, v] of Object.entries(overrides)) {
      current[k] = v;
    }
  },

  /** Write a raw value to the DB (low-level, prefer update.*). */
  setRaw: writeRaw,

  // --- Setup & auth ---
  setup: {
    clearCache: clearSetupCompleteCache,
    complete: completeSetup,
    isComplete: isSetupComplete,
  },
  get showPublicApi(): boolean {
    return snap("show_public_api");
  },
  // --- SMS gateway ---
  smsGateway: {
    get hasPassphrase(): boolean {
      return snap("sms_gateway_passphrase") !== "";
    },
    get hasPassword(): boolean {
      return snap("sms_gateway_password") !== "";
    },
    get hasWebhookSecret(): boolean {
      return snap("sms_gateway_webhook_secret") !== "";
    },
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

  // --- Superuser ---
  get superuserChoice(): SuperuserChoice {
    const choice = snap("superuser_choice");
    return isSuperuserChoice(choice) ? choice : "";
  },
  get theme(): Theme {
    return snap("theme");
  },
  get timezone(): string {
    return snap("timezone");
  },
  get underlineLinks(): boolean {
    return snap("underline_links");
  },

  // -----------------------------------------------------------------------
  // Async writes — settings.update.*
  // -----------------------------------------------------------------------
  update: {
    ...stringAccessors.updaters,
    // --- Address lookup writes ---
    addressLookup: {
      apiKey: encryptedUpdate(CONFIG_KEYS.ADDRESS_LOOKUP_API_KEY),
      provider: plaintextUpdate(CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER) as (
        v: AddressLookupSetting,
      ) => Promise<void>,
    },
    // --- Apple Wallet writes ---
    appleWallet: appleWallet.createUpdateSettings(encryptedUpdate),
    autoPurgeOrphans: boolUpdate(
      CONFIG_KEYS.AUTO_PURGE_ORPHANS,
      "auto_purge_orphans",
    ),
    bookingFee: async (v: string): Promise<void> => {
      await writeOrDelete(CONFIG_KEYS.BOOKING_FEE, v);
      data.booking_fee = v || "0";
    },
    calendarFeedsEnabled: boolUpdate(
      CONFIG_KEYS.CALENDAR_FEEDS_ENABLED,
      "calendar_feeds_enabled",
    ),
    calendarFeedsGroupBy: rawUpdate(
      CONFIG_KEYS.CALENDAR_FEEDS_GROUP_BY,
      "calendar_feeds_group_by",
    ) as (v: "attendees" | "listings") => Promise<void>,
    clearPaymentProvider: async (): Promise<void> => {
      await deleteRaw(CONFIG_KEYS.PAYMENT_PROVIDER);
      data.payment_provider = null;
      data.payment_provider_setting = null;
    },
    contactFormEnabled: boolUpdate(
      CONFIG_KEYS.CONTACT_FORM_ENABLED,
      "contact_form_enabled",
    ),
    customDomainLastValidated: timestampUpdate(
      CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
      "custom_domain_last_validated",
    ),

    // --- Email writes ---
    email: {
      apiKey: encryptedUpdate(CONFIG_KEYS.EMAIL_API_KEY),
      fromAddress: encryptedUpdate(CONFIG_KEYS.EMAIL_FROM_ADDRESS),
      provider: plaintextUpdate(CONFIG_KEYS.EMAIL_PROVIDER),
      template: async (
        type: EmailTemplateType,
        format: EmailTemplateFormat,
        content: string,
      ): Promise<void> => {
        const key = TEMPLATE_KEYS[`${type}:${format}`];
        await writeEncrypted(key, content);
        setSnapshotField(key, content);
      },
    },
    externalOrderEnabled: boolUpdate(
      CONFIG_KEYS.EXTERNAL_ORDER_ENABLED,
      "external_order_enabled",
    ),
    // --- Google Wallet writes ---
    googleWallet: googleWallet.createUpdateSettings(encryptedUpdate),
    listingDefaults: async (v: ListingDefaults): Promise<void> => {
      const json = serializeListingDefaults(v);
      await writeEncrypted(CONFIG_KEYS.LISTING_DEFAULTS, json);
      setSnapshotField(CONFIG_KEYS.LISTING_DEFAULTS, json);
    },
    orderEnabled: boolUpdate(CONFIG_KEYS.ORDER_ENABLED, "order_enabled"),
    orphanPurgeRetention: rawUpdate(
      CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
      "orphan_purge_retention",
    ),
    paymentProvider: async (v: PaymentProviderType): Promise<void> => {
      await writeRaw(CONFIG_KEYS.PAYMENT_PROVIDER, v);
      data.payment_provider = v;
      data.payment_provider_setting = v;
    },
    setPaymentProviderNone: async (): Promise<void> => {
      await writeRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
      data.payment_provider = null;
      data.payment_provider_setting = "none";
    },
    showPublicApi: boolUpdate(CONFIG_KEYS.SHOW_PUBLIC_API, "show_public_api"),

    // --- Square writes ---
    square: {
      accessToken: encryptedUpdate(CONFIG_KEYS.SQUARE_ACCESS_TOKEN),
      locationId: rawUpdate(
        CONFIG_KEYS.SQUARE_LOCATION_ID,
        "square_location_id",
      ),
      sandbox: boolUpdate(CONFIG_KEYS.SQUARE_SANDBOX, "square_sandbox"),
      webhookSignatureKey: encryptedUpdate(
        CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
      ),
    },
    // --- Stripe writes ---
    stripe: {
      secretKey: encryptedUpdate(CONFIG_KEYS.STRIPE_SECRET_KEY),
      webhookConfig: async (config: {
        secret: string;
        endpointId: string;
      }): Promise<void> => {
        // Save both values in one atomic batch so a partial write can never
        // leave a new secret paired with an old endpoint ID (or vice versa).
        await writeRawBatch([
          [CONFIG_KEYS.STRIPE_WEBHOOK_SECRET, await encrypt(config.secret)],
          [CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID, config.endpointId],
        ]);
        data.stripe_webhook_secret = config.secret;
        data.stripe_webhook_endpoint_id = config.endpointId;
      },
    },
    // --- SumUp writes ---
    sumup: {
      apiKey: encryptedUpdate(CONFIG_KEYS.SUMUP_API_KEY),
      merchantCode: plaintextUpdate(CONFIG_KEYS.SUMUP_MERCHANT_CODE),
    },
    superuserChoice: plaintextUpdate(CONFIG_KEYS.SUPERUSER_CHOICE) as (
      v: SuperuserChoice,
    ) => Promise<void>,
    supportFormLastSubmitted: timestampUpdate(
      CONFIG_KEYS.SUPPORT_FORM_LAST_SUBMITTED,
      "support_form_last_submitted",
    ),
    theme: rawUpdate(CONFIG_KEYS.THEME, "theme") as (v: Theme) => Promise<void>,
    underlineLinks: boolUpdate(CONFIG_KEYS.UNDERLINE_LINKS, "underline_links"),
  },
  updateUserPassword,
  /**
   * The settings version the loaded snapshot is stamped at (`-1` before any
   * load). Synchronous — it reads the in-memory cache stamp, not the DB — so it
   * is safe to call during a render. Used to cache-bust assets whose body is a
   * setting (e.g. /custom.css): every settings write bumps this counter, so a
   * URL keyed on it changes whenever any setting changes, letting the asset be
   * served immutable while edits still appear on the next request.
   */
  get version(): number {
    return getCacheState().version;
  },
  withCurrentTask,
};

export const settings = withProperties(settingsBase, stringAccessors.getters);
