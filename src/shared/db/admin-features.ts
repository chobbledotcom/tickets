import * as v from "valibot";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { enabledFeaturesAreValidSql } from "#db/admin-feature-sql.ts";
import {
  abortUnless,
  executeBatchWithResults,
  queryOne,
  queryOnePrimary,
  requireOnePrimary,
  resultRows,
} from "#db/client.ts";
import { invalidateListingsCache } from "#db/listings/records.ts";
import { notNullGuardFailure } from "#db/query.ts";
import { settingsVersionIncrement } from "#db/settings/cache.ts";
import {
  type BooleanJsonField,
  booleanJsonField,
} from "#db/settings/json-field.ts";
import {
  publishStoredSetting,
  syncStoredSetting,
} from "#db/settings/raw-writes.ts";
import { setSnapshotField } from "#db/settings/snapshot.ts";
import { type SqlStatement, sql, sqlCommas, sqlLiteral } from "#db/sql.ts";
import { range } from "#fp";
import {
  ADMIN_FEATURES,
  type AdminFeatureDefinition,
  type AdminFeatureKey,
  type EnabledFeatures,
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import {
  parseListingDefaults,
  serializeListingDefaults,
} from "#shared/listing-defaults.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

const StoredValueSchema = v.object({ value: v.string() });
const JSON_WRITE_ATTEMPTS = 8;

type AdminFeaturesByKey = {
  [Feature in AdminFeatureDefinition as Feature["key"]]: Feature;
};

const FEATURES_BY_KEY = Object.fromEntries(
  ADMIN_FEATURES.map((feature) => [feature.key, feature]),
) as AdminFeaturesByKey;

const requireSettingCondition = abortUnless(
  sql`settings (key, value)`,
  sql`${"__required_setting_condition__"}, NULL`,
);

const initialFeatureValue = (key: AdminFeatureKey, enabled: boolean): string =>
  serializeEnabledFeatures(
    setFeatureEnabled(parseEnabledFeatures(""), key, enabled),
  );

const featureField = (
  key: AdminFeatureKey,
  enabled: boolean,
): BooleanJsonField =>
  booleanJsonField(
    CONFIG_KEYS.ENABLED_FEATURES,
    initialFeatureValue(key, enabled),
    `$.${key}`,
    enabled,
  );

const usageJsonEntry = (feature: AdminFeatureDefinition): SqlStatement =>
  sql`${sqlLiteral(feature.key)}, json(IIF(${feature.inUseSql ?? sql`FALSE`}, 'true', 'false'))`;

/** Read every feature's usage in one database round trip. Money deliberately
 * has no usage rule: its switch only controls display and is always changeable. */
export const getAdminFeatureUsage = async (): Promise<EnabledFeatures> => {
  const row = v.parse(
    StoredValueSchema,
    await queryOne<unknown>(
      sql`SELECT json_object(${sqlCommas(ADMIN_FEATURES.map(usageJsonEntry))}) AS value`,
    ),
  );
  return parseEnabledFeatures(row.value);
};

const featureWriteStatement = (
  key: AdminFeatureKey,
  enabled: boolean,
  when: SqlStatement,
): SqlStatement => featureField(key, enabled).statement(when);

const syncFeatureSetting = (stored: string): void =>
  publishStoredSetting(CONFIG_KEYS.ENABLED_FEATURES, stored);

const writeAdminFeatureEnabled = async (
  key: AdminFeatureKey,
  enabled: boolean,
): Promise<boolean> => {
  const inUseSql = FEATURES_BY_KEY[key].inUseSql;
  const stored = await featureField(key, enabled).write(
    !enabled && inUseSql ? sql`NOT (${inUseSql})` : sql`TRUE`,
    parseEnabledFeatures,
  );
  if (stored === null) return false;
  return true;
};

type PreparedLogisticsDefault = {
  current: string | null;
  nextEncrypted: string | null;
  nextPlain: string | null;
};

const prepareLogisticsDefault = async (): Promise<PreparedLogisticsDefault> => {
  const result = await queryOnePrimary<unknown>(
    sql`SELECT value FROM settings WHERE key = ${CONFIG_KEYS.LISTING_DEFAULTS}`,
  );
  if (result === null) {
    return { current: null, nextEncrypted: null, nextPlain: null };
  }
  const current = v.parse(StoredValueSchema, result).value;
  const defaults = parseListingDefaults(
    await decrypt(current as EnvKeyEncrypted),
  );
  if (defaults.usesLogistics === undefined) {
    return { current, nextEncrypted: null, nextPlain: null };
  }
  delete defaults.usesLogistics;
  const nextPlain = serializeListingDefaults(defaults);
  return {
    current,
    nextEncrypted: await encrypt(nextPlain),
    nextPlain,
  };
};

const listingDefaultsUnchanged = (current: string | null): SqlStatement =>
  current === null
    ? sql`NOT EXISTS (
          SELECT 1 FROM settings WHERE key = ${sqlLiteral(CONFIG_KEYS.LISTING_DEFAULTS)}
        )`
    : sql`EXISTS (
          SELECT 1 FROM settings
          WHERE key = ${sqlLiteral(CONFIG_KEYS.LISTING_DEFAULTS)} AND value = ${current}
        )`;

const logisticsDisableStatements = (
  prepared: PreparedLogisticsDefault,
): { featureResultIndex: number; statements: SqlStatement[] } => {
  const unchanged = listingDefaultsUnchanged(prepared.current);
  const statements: SqlStatement[] = [requireSettingCondition(unchanged)];
  if (prepared.nextEncrypted !== null) {
    statements.push(
      sql`UPDATE settings SET value = ${prepared.nextEncrypted} WHERE key = ${CONFIG_KEYS.LISTING_DEFAULTS} AND value = ${prepared.current}`,
    );
  }
  statements.push(
    requireSettingCondition(sql`NOT (${FEATURES_BY_KEY.logistics.inUseSql})`),
  );
  statements.push(featureWriteStatement("logistics", false, sql`TRUE`));
  statements.push(
    requireSettingCondition(sql`EXISTS (
      SELECT 1 FROM settings
      WHERE key = ${sqlLiteral(CONFIG_KEYS.ENABLED_FEATURES)}
        AND ${enabledFeaturesAreValidSql(sql`value`)}
    )`),
  );
  const featureResultIndex = statements.length;
  statements.push(
    sql`SELECT value FROM settings WHERE key = ${CONFIG_KEYS.ENABLED_FEATURES}`,
    settingsVersionIncrement(),
  );
  return { featureResultIndex, statements };
};

const syncLogisticsDisable = (
  prepared: PreparedLogisticsDefault,
  storedFeatures: string,
): void => {
  if (prepared.nextEncrypted !== null && prepared.nextPlain !== null) {
    const nextEncrypted = prepared.nextEncrypted;
    syncStoredSetting(CONFIG_KEYS.LISTING_DEFAULTS, (values) =>
      values.set(CONFIG_KEYS.LISTING_DEFAULTS, nextEncrypted),
    );
    setSnapshotField(CONFIG_KEYS.LISTING_DEFAULTS, prepared.nextPlain);
    invalidateListingsCache();
  }
  syncFeatureSetting(storedFeatures);
};

const saveLogisticsDisable = async (
  prepared: PreparedLogisticsDefault,
): Promise<void> => {
  const { featureResultIndex, statements } =
    logisticsDisableStatements(prepared);
  const results = await executeBatchWithResults(statements);
  const row = v.parse(
    StoredValueSchema,
    resultRows<unknown>(results[featureResultIndex]!)[0],
  );
  syncLogisticsDisable(prepared, row.value);
};

const validateStoredFeatureSetting = async (): Promise<void> => {
  const stored = await requireOnePrimary<unknown>(
    sql`SELECT value FROM settings WHERE key = ${CONFIG_KEYS.ENABLED_FEATURES}`,
  );
  const row = v.parse(StoredValueSchema, stored);
  parseEnabledFeatures(row.value);
};

const disableLogisticsFeature = async (): Promise<boolean> => {
  for (const _attempt of range(0, JSON_WRITE_ATTEMPTS)) {
    const prepared = await prepareLogisticsDefault();
    try {
      await saveLogisticsDisable(prepared);
      return true;
    } catch (error) {
      if (!notNullGuardFailure(error, "settings.value")) throw error;
      await validateStoredFeatureSetting();
      if ((await prepareLogisticsDefault()).current !== prepared.current) {
        continue;
      }
      return false;
    }
  }
  throw new Error("Listing defaults changed too often to disable Logistics");
};

/** Change one feature without replacing other feature choices that were
 * saved at the same time. Logistics also removes its listing default in the
 * same transaction when it is disabled. */
export const setAdminFeatureEnabled = (
  key: AdminFeatureKey,
  enabled: boolean,
): Promise<boolean> =>
  key === "logistics" && !enabled
    ? disableLogisticsFeature()
    : writeAdminFeatureEnabled(key, enabled);
