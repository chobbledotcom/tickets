/**
 * In-memory snapshot of every setting — pre-resolved so request handlers can
 * read synchronously. Populated by `loadKeys`; reset to defaults by
 * `invalidateCache`.
 *
 * The snapshot is the bridge between the async load path and the sync getter
 * API: each settings write mirrors its new value into the snapshot so the rest
 * of the request sees the change without re-loading.
 */

import { DEFAULT_COUNTRY } from "#shared/countries.ts";
import type { KeyEncrypted, OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import { recordSettingRead } from "#shared/db/settings-audit.ts";
/* jscpd:ignore-start — the orphan-retention → CONFIG_KEYS → registry key lists
   are the same triad apply.ts loads; shared infrastructure, not code that
   changes per file. */
import { DEFAULT_ORPHAN_RETENTION } from "#shared/orphan-retention.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import {
  ENCRYPTED_KEYS,
  PLAINTEXT_KEYS,
  type StringSettingKey,
} from "#shared/settings/registry.ts";
/* jscpd:ignore-end */
import { DEFAULT_TIMEZONE } from "#shared/timezone-default.ts";
import type {
  PaymentProviderSetting,
  PaymentProviderType,
  SuperuserChoice,
  Theme,
} from "#shared/types.ts";

export type { StringSettingKey };

/** Snapshot fields whose stored value is itself a sealed string (the snapshot
 * holds it verbatim, still sealed): the bulk-email draft is owner-key
 * ciphertext, and the owner private key is KeyEncrypted under the DATA_KEY.
 * Empty string still means "no value". The public key is a plain JWK string. */
type SealedSettingFields = {
  bulk_email_draft: OwnerKeyEncrypted | "";
  wrapped_private_key: KeyEncrypted | "";
};

/** All string setting fields: empty string means "no value". Fields listed in
 * {@link SealedSettingFields} carry their sealed type; the rest are plain. */
type StringSettingFields = {
  [K in StringSettingKey]: K extends keyof SealedSettingFields
    ? SealedSettingFields[K]
    : string;
};

/** Generate empty-string defaults for every string setting field. */
const stringSettingDefaults = Object.fromEntries(
  [...PLAINTEXT_KEYS, ...ENCRYPTED_KEYS].map((k) => [k, ""]),
) as StringSettingFields;

/** Non-string snapshot fields that need explicit types. */
type SpecificFields = {
  country: string;
  theme: Theme;
  underline_links: boolean;
  show_public_site: boolean;
  show_public_api: boolean;
  external_order_enabled: boolean;
  calendar_feeds_enabled: boolean;
  calendar_feeds_group_by: string;
  contact_form_enabled: boolean;
  order_enabled: boolean;
  payment_provider: PaymentProviderType | null;
  payment_provider_setting: PaymentProviderSetting | null;
  booking_fee: string;
  square_sandbox: boolean;
  superuser_choice: SuperuserChoice;
  currency: string;
  timezone: string;
  phone_prefix: string;
  auto_purge_orphans: boolean;
  orphan_purge_retention: string;
};

/** Full settings snapshot type. */
export type SettingsData = SpecificFields & StringSettingFields;

/** Mutable snapshot of all settings. Populated by loadKeys(). */
export const data: SettingsData = {
  auto_purge_orphans: true,
  booking_fee: "0",
  calendar_feeds_enabled: false,
  calendar_feeds_group_by: "attendees",
  contact_form_enabled: false,
  country: DEFAULT_COUNTRY,
  currency: "GBP",
  external_order_enabled: false,
  order_enabled: false,
  orphan_purge_retention: DEFAULT_ORPHAN_RETENTION,
  payment_provider: null,
  payment_provider_setting: null,
  phone_prefix: "+44",
  show_public_api: false,
  show_public_site: false,
  square_sandbox: false,
  theme: "light",
  timezone: DEFAULT_TIMEZONE,
  underline_links: false,
  ...stringSettingDefaults,
  superuser_choice: "",
};

/** Frozen defaults — `invalidateCache` resets the live snapshot back to these. */
export const defaults: Readonly<SettingsData> = { ...data };

/** Type-safe setter for a single snapshot field. */
export const setSnapshotField = <K extends keyof SettingsData>(
  key: K,
  value: SettingsData[K],
): void => {
  data[key] = value;
};

/** Snapshot keys whose value is a boolean. */
export type BoolSettingKey = {
  [K in keyof SettingsData]: SettingsData[K] extends boolean ? K : never;
}[keyof SettingsData];

/** Test overrides — survive invalidateCache(), cleared by clearTestOverrides().
 *
 * Backed by a small mutable record held in this module. The namespace's
 * `setForTest`/`clearTestOverride` fetch the record through `getTestOverrides`
 * and mutate it directly; `clearTestOverrides` swaps it for a fresh empty
 * record. */
const testOverrideStore = (() => {
  let overrides: Record<string, unknown> = {};
  return {
    clear(): void {
      overrides = {};
    },
    get(): Record<string, unknown> {
      return overrides;
    },
  };
})();

export const getTestOverrides = (): Record<string, unknown> =>
  testOverrideStore.get();

export const clearTestOverrides = (): void => {
  testOverrideStore.clear();
};

/**
 * Snapshot fields that derive from a different config key, for the read audit.
 * Country drives currency/timezone/phone_prefix; the payment-provider setting
 * shares PAYMENT_PROVIDER's row. Every other field's name equals its config key.
 */
const AUDIT_KEY_OVERRIDES: Record<string, string> = {
  currency: CONFIG_KEYS.COUNTRY,
  payment_provider_setting: CONFIG_KEYS.PAYMENT_PROVIDER,
  phone_prefix: CONFIG_KEYS.COUNTRY,
  timezone: CONFIG_KEYS.COUNTRY,
};

/** Map a snapshot field name to the config key whose load satisfies it. */
const auditKeyFor = (field: string): string =>
  AUDIT_KEY_OVERRIDES[field] ?? field;

/** Read a snapshot value, checking test overrides first. */
export const snap = <K extends keyof SettingsData>(key: K): SettingsData[K] => {
  const overrides = getTestOverrides();
  // A test override supplies the value directly, so the read doesn't depend on
  // a declared load — skip the audit (production never has overrides).
  if (key in overrides) return overrides[key] as SettingsData[K];
  recordSettingRead(auditKeyFor(key as string));
  return data[key];
};
