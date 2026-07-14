/**
 * Per-key snapshot resolvers — the load side of `loadKeys`.
 *
 * Each config key may drive one or more snapshot fields: COUNTRY →
 * currency/timezone/phone_prefix; PAYMENT_PROVIDER → provider + setting. The
 * appliers take the raw (still-encrypted-for-encrypted-keys) value and either
 * apply it directly (plaintext/special) or decrypt it into the snapshot.
 *
 * `SNAPSHOT_KEYS` is the ordered list of config keys that affect the snapshot;
 * `ALL_SETTINGS_KEYS` adds the setup-complete flag for callers that need every
 * setting loaded.
 */

/* jscpd:ignore-start */
import { DEFAULT_COUNTRY, getCountry } from "#shared/countries.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  ENCRYPTED_KEY_SET,
  PLAINTEXT_KEY_SET,
} from "#shared/db/settings/accessors.ts";
import {
  type BoolSettingKey,
  data,
  type SettingsData,
  setSnapshotField,
} from "#shared/db/settings/snapshot.ts";
import {
  DEFAULT_ORPHAN_RETENTION,
  isOrphanRetentionValue,
} from "#shared/orphan-retention.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import {
  ENCRYPTED_KEYS,
  PLAINTEXT_KEYS,
  type StringSettingKey,
} from "#shared/settings/registry.ts";
import {
  type EmailTemplateFormat,
  type EmailTemplateType,
  isPaymentProvider,
  isPaymentProviderSetting,
} from "#shared/types.ts";

/* jscpd:ignore-end */

/** Template type:format → config key */
type TemplateKeyMap = `${EmailTemplateType}:${EmailTemplateFormat}`;
export const TEMPLATE_KEYS: Record<TemplateKeyMap, StringSettingKey> = {
  "admin:html": "email_tpl_admin_html",
  "admin:subject": "email_tpl_admin_subject",
  "admin:text": "email_tpl_admin_text",
  "confirmation:html": "email_tpl_confirmation_html",
  "confirmation:subject": "email_tpl_confirmation_subject",
  "confirmation:text": "email_tpl_confirmation_text",
};

type CountryInfo = ReturnType<typeof getCountry>;
const applyCountryDerived = (info: CountryInfo): void => {
  data.currency = info.currency;
  data.timezone = info.timezone;
  data.phone_prefix = info.phonePrefix;
};

/** Applier for a boolean snapshot field: on ⇔ the raw value is exactly "true"
 *  (an absent/garbled value reads as off), mirroring how {@link boolUpdate}
 *  writes the flag. */
const boolApply =
  (field: BoolSettingKey) =>
  (raw: string | undefined): void => {
    data[field] = raw === "true";
  };

/**
 * Per-key resolvers for the non-string snapshot fields. A config key may drive
 * more than one snapshot field (COUNTRY → currency/timezone/phone_prefix;
 * PAYMENT_PROVIDER → provider + setting). `raw` is undefined when the key is
 * absent from the DB, in which case the default is applied.
 */
const SPECIAL_APPLIERS: Record<string, (raw: string | undefined) => void> = {
  [CONFIG_KEYS.COUNTRY]: (raw) => {
    const country = raw || DEFAULT_COUNTRY;
    data.country = country;
    applyCountryDerived(getCountry(country));
  },
  [CONFIG_KEYS.THEME]: (raw) => {
    data.theme = raw === "dark" ? "dark" : "light";
  },
  [CONFIG_KEYS.UNDERLINE_LINKS]: boolApply("underline_links"),
  [CONFIG_KEYS.SHOW_PUBLIC_SITE]: boolApply("show_public_site"),
  [CONFIG_KEYS.SHOW_PUBLIC_API]: boolApply("show_public_api"),
  [CONFIG_KEYS.EXTERNAL_ORDER_ENABLED]: boolApply("external_order_enabled"),
  [CONFIG_KEYS.CALENDAR_FEEDS_ENABLED]: boolApply("calendar_feeds_enabled"),
  [CONFIG_KEYS.CALENDAR_FEEDS_GROUP_BY]: (raw) => {
    data.calendar_feeds_group_by =
      raw === "listings" ? "listings" : "attendees";
  },
  [CONFIG_KEYS.CONTACT_FORM_ENABLED]: boolApply("contact_form_enabled"),
  [CONFIG_KEYS.ORDER_ENABLED]: boolApply("order_enabled"),
  // Defaults ON: only an explicit "false" disables automatic orphan purging.
  [CONFIG_KEYS.AUTO_PURGE_ORPHANS]: (raw) => {
    data.auto_purge_orphans = raw !== "false";
  },
  // Coerce an absent/garbled value back to the default age, so a bad row can
  // never widen the purge window.
  [CONFIG_KEYS.ORPHAN_PURGE_RETENTION]: (raw) => {
    data.orphan_purge_retention =
      raw && isOrphanRetentionValue(raw) ? raw : DEFAULT_ORPHAN_RETENTION;
  },
  [CONFIG_KEYS.HAS_LOGISTICS]: boolApply("has_logistics"),
  [CONFIG_KEYS.PAYMENT_PROVIDER]: (raw) => {
    data.payment_provider = raw && isPaymentProvider(raw) ? raw : null;
    data.payment_provider_setting =
      raw && isPaymentProviderSetting(raw) ? raw : null;
  },
  [CONFIG_KEYS.BOOKING_FEE]: (raw) => {
    data.booking_fee = raw ?? "0";
  },
  [CONFIG_KEYS.SQUARE_SANDBOX]: boolApply("square_sandbox"),
};

/** Every config key that maps to a snapshot field, in load order. */
export const SNAPSHOT_KEYS: readonly string[] = [
  ...Object.keys(SPECIAL_APPLIERS),
  ...PLAINTEXT_KEYS,
  ...ENCRYPTED_KEYS,
];

/**
 * All keys that populate the snapshot plus the setup-complete flag. Equivalent
 * to the former `loadAll` SELECT * in terms of what affects request behaviour.
 * Use in tests and in pre-load bundles that need every setting.
 */
export const ALL_SETTINGS_KEYS: readonly string[] = [
  ...SNAPSHOT_KEYS,
  CONFIG_KEYS.SETUP_COMPLETE,
];

/**
 * Resolve one config key from `values` into the snapshot. Encrypted keys are
 * decrypted (hence async); plaintext and special keys are synchronous. Keys
 * with no snapshot field (e.g. SETUP_COMPLETE) are no-ops — they live in the
 * raw cache only.
 */
export const applyKey = async (
  key: string,
  values: Map<string, string>,
): Promise<void> => {
  const special = SPECIAL_APPLIERS[key];
  if (special) return special(values.get(key));
  if (ENCRYPTED_KEY_SET.has(key)) {
    const v = values.get(key);
    // Raw settings row for a key the registry declares encrypted — the
    // read-boundary assertion, mirroring col.encrypted's read transform.
    setSnapshotField(
      key as StringSettingKey,
      v ? await decrypt(v as EnvKeyEncrypted) : "",
    );
    return;
  }
  if (PLAINTEXT_KEY_SET.has(key)) {
    setSnapshotField(key as StringSettingKey, values.get(key) ?? "");
  }
};

/** Resolve a batch of keys into the snapshot, decrypting in parallel. */
export const applyKeys = async (
  keys: readonly string[],
  values: Map<string, string>,
): Promise<void> => {
  await Promise.all(keys.map((key) => applyKey(key, values)));
};

export type { SettingsData };
