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
import {
  isSet,
  known,
  snapGetters,
  withProperties,
} from "#db/settings/namespace.ts";
import { updateUserPassword } from "#db/settings/password.ts";
import { paymentProviderAccessors } from "#db/settings/payment-provider.ts";
import {
  encryptedUpdate,
  getRawCached,
  plaintextUpdate,
  writeEncrypted,
  writeOrDelete,
  writeRaw,
  writeRawBatch,
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
import { parseTaxPolicy, updateTaxPolicy } from "#db/settings/tax.ts";
import { cssUsesBunnyFonts } from "#routes/public/bunny-fonts.ts";
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
import type { TaxPolicy } from "#shared/tax/types.ts";
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
  addressLookup: snapGetters({
    apiKey: "address_lookup_api_key",
    hasKey: isSet("address_lookup_api_key"),
    provider: known({
      fallback: "none",
      isKnown: isAddressLookupSetting,
      key: "address_lookup_provider",
    }),
  }),
  // --- Apple Wallet ---
  appleWallet: appleWallet.createReadSettings(snap as (k: string) => string),
  get attendeeColumnLayout(): TableLayout<AttendeeColumnKey> {
    return configurableTableLayouts.attendee.parse(
      snap("attendee_column_order"),
    );
  },

  // -----------------------------------------------------------------------
  // Sync reads — all populated by loadKeys()
  // -----------------------------------------------------------------------

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

  // --- Email ---
  email: withProperties(
    snapGetters({
      apiKey: "email_api_key",
      fromAddress: "email_from_address",
      hasApiKey: isSet("email_api_key"),
      provider: "email_provider",
    }),
    {
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
  ),
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
  // --- SMS gateway ---
  smsGateway: snapGetters({
    hasPassphrase: isSet("sms_gateway_passphrase"),
    hasPassword: isSet("sms_gateway_password"),
    hasWebhookSecret: isSet("sms_gateway_webhook_secret"),
  }),

  // --- Superuser ---
  get tax(): TaxPolicy {
    return parseTaxPolicy(snap(CONFIG_KEYS.TAX));
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
    /** Save the stylesheet and the fonts flag it derives in one batch. A save
     *  without a Bunny reference clears the flag. No reader sees the CSS
     *  without its flag. */
    customCss: async (v: string): Promise<void> => {
      const bunnyFonts = cssUsesBunnyFonts(v);
      await writeRawBatch([
        [CONFIG_KEYS.CUSTOM_CSS, v],
        [CONFIG_KEYS.CUSTOM_CSS_BUNNY_FONTS, bunnyFonts ? "true" : "false"],
      ]);
      setSnapshotField(CONFIG_KEYS.CUSTOM_CSS, v);
      setSnapshotField(CONFIG_KEYS.CUSTOM_CSS_BUNNY_FONTS, bunnyFonts);
    },
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
    tax: updateTaxPolicy,
    theme: rawUpdate(CONFIG_KEYS.THEME, "theme") as (v: Theme) => Promise<void>,
    underlineLinks: boolUpdate(CONFIG_KEYS.UNDERLINE_LINKS, "underline_links"),
    welcomeEnabled: boolUpdate(CONFIG_KEYS.WELCOME_ENABLED, "welcome_enabled"),
  },
  updateUserPassword,
  /**
   * The settings version the loaded snapshot is stamped at (`-1` before any
   * load). Synchronous — it reads the in-memory cache stamp, not the DB — so it
   * is safe to call during a render. Used to cache-bust assets whose body is a
   * setting (for example, /custom.css). Every settings write bumps this
   * counter, so a URL keyed on it changes whenever any setting changes. The
   * asset is then served immutable while edits still appear on the next
   * request.
   */
  get version(): number {
    return getCacheState().version;
  },
  withCurrentTask,
};

/** The stored settings that read straight from the snapshot, one getter per
 *  name. Kept beside the namespace literal, so a new stored setting is one
 *  line here rather than a hand-written getter. */
const storedSettingGetters = snapGetters({
  autoPurgeOrphans: "auto_purge_orphans",
  bookingFee: "booking_fee",
  calendarFeedsEnabled: "calendar_feeds_enabled",
  contactFormEnabled: "contact_form_enabled",
  country: "country",
  currency: "currency",
  /** Derived when the stylesheet is saved, so the CSP builder reads a flag
   *  instead of scanning it on every response. */
  customCssBunnyFonts: "custom_css_bunny_fonts",
  externalOrderEnabled: "external_order_enabled",
  orderEnabled: "order_enabled",
  orphanPurgeRetention: "orphan_purge_retention",
  phonePrefix: "phone_prefix",
  showPublicApi: "show_public_api",
  superuserChoice: known({
    fallback: "",
    isKnown: isSuperuserChoice,
    key: "superuser_choice",
  }),
  theme: "theme",
  timezone: "timezone",
  underlineLinks: "underline_links",
  /** An absent stored value reads as off, so a site that never stored the
   *  flag never shows the welcome message. */
  welcomeEnabled: "welcome_enabled",
});

/** The namespace: the literal above, plus the parts that build their own
 *  getters. */

export const settings = withProperties(
  withProperties(
    withProperties(settingsBase, storedSettingGetters),
    paymentProviderAccessors.getters,
  ),
  stringAccessors.getters,
);
