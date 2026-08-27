/**
 * Settings — sync reads, async writes.
 *
 * `settings.loadKeys(keys)` must run before a request reads anything. After
 * that every setting is a plain sync property, so a read needs no await.
 */

import {
  boolUpdate,
  rawUpdate,
  stringAccessors,
  timestampUpdate,
} from "#db/settings/accessors.ts";
import {
  ALL_SETTINGS_KEYS,
  SNAPSHOT_KEYS,
  TEMPLATE_KEYS,
} from "#db/settings/apply.ts";
import {
  bumpSettingsVersion,
  getCacheState,
  getCurrentSettingsVersion,
  prefetchVersion,
} from "#db/settings/cache.ts";
import { withCurrentTask } from "#db/settings/current-task.ts";
import { invalidateCache, loadKeys } from "#db/settings/load.ts";
import { withProperties } from "#db/settings/namespace.ts";
import { updateUserPassword } from "#db/settings/password.ts";
import { paymentProviderAccessors } from "#db/settings/payment-provider.ts";
import {
  encryptedUpdate,
  getRawCached,
  plaintextUpdate,
  writeEncrypted,
  writeOrDelete,
  writeRaw,
} from "#db/settings/raw-writes.ts";
import {
  clearSetupCompleteCache,
  completeSetup,
  isSetupComplete,
  SetupAlreadyCompleteError,
} from "#db/settings/setup.ts";
import {
  clearTestOverrides,
  data,
  getTestOverrides,
  type SettingsData,
  setSnapshotField,
  snap,
} from "#db/settings/snapshot.ts";
import {
  type AddressLookupSetting,
  isAddressLookupSetting,
} from "#shared/address-lookup/types.ts";
import {
  type EnabledFeatures,
  parseEnabledFeatures,
} from "#shared/admin-features.ts";
import {
  type ListingDefaults,
  parseListingDefaults,
  serializeListingDefaults,
} from "#shared/listing-defaults.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { EMAIL_BODY_KEYS } from "#shared/settings/registry.ts";
import {
  type AttendeeColumnKey,
  configurableTableLayouts,
  type ListingColumnKey,
} from "#shared/tables/configurable.ts";
import type { TableLayout } from "#shared/tables/layout.ts";
import { appleWallet } from "#shared/wallets/apple-wallet-settings.ts";
import { googleWallet } from "#shared/wallets/google-wallet-settings.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import {
  type EmailTemplateFormat,
  type EmailTemplateType,
  isSuperuserChoice,
  type SuperuserChoice,
  type Theme,
} from "#types";

export type { SettingsData };
export {
  ALL_SETTINGS_KEYS,
  bumpSettingsVersion,
  CONFIG_KEYS,
  EMAIL_BODY_KEYS,
  getCurrentSettingsVersion,
  SetupAlreadyCompleteError,
  SNAPSHOT_KEYS,
};

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
  get attendeeColumnLayout(): TableLayout<AttendeeColumnKey> {
    return configurableTableLayouts.attendee.parse(
      snap("attendee_column_order"),
    );
  },
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
  get listingColumnLayout(): TableLayout<ListingColumnKey> {
    return configurableTableLayouts.listing.parse(snap("listing_column_order"));
  },
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
    ...paymentProviderAccessors.updaters,
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
    showPublicApi: boolUpdate(CONFIG_KEYS.SHOW_PUBLIC_API, "show_public_api"),

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

/** The namespace: the literal above, plus the two parts that build their own
 *  getters. */
export const settings = withProperties(
  withProperties(settingsBase, paymentProviderAccessors.getters),
  stringAccessors.getters,
);
