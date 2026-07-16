import * as v from "valibot";
import {
  ADMIN_FEATURES,
  type AdminFeatureDefinition,
  type AdminFeatureKey,
  type EnabledFeatures,
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  executeBatchWithResults,
  queryOne,
  queryOnePrimary,
  resultRows,
  type SqlStatement,
} from "#shared/db/client.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { settingsVersionIncrement } from "#shared/db/settings/cache.ts";
import {
  type BooleanJsonField,
  booleanJsonField,
} from "#shared/db/settings/json-field.ts";
import { syncStoredSetting } from "#shared/db/settings/raw-writes.ts";
import { setSnapshotField } from "#shared/db/settings/snapshot.ts";
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

const requireSettingCondition = (
  conditionSql: string,
  conditionArgs: readonly string[] = [],
): SqlStatement => ({
  args: ["__required_setting_condition__", ...conditionArgs],
  sql: `INSERT INTO settings (key, value)
        SELECT ?, NULL WHERE NOT (${conditionSql})`,
});

const isRequiredSettingWriteFailure = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes("NOT NULL constraint failed: settings.value");

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

const usageJsonEntry = (feature: AdminFeatureDefinition): string =>
  `'${feature.key}', json(IIF(${feature.inUseSql ?? "FALSE"}, 'true', 'false'))`;

/** Read every feature's usage in one database round trip. Money deliberately
 * has no usage rule: its switch only controls display and is always changeable. */
export const getAdminFeatureUsage = async (): Promise<EnabledFeatures> => {
  const row = v.parse(
    StoredValueSchema,
    await queryOne<unknown>(
      `SELECT json_object(${ADMIN_FEATURES.map(usageJsonEntry).join(", ")}) AS value`,
    ),
  );
  return parseEnabledFeatures(row.value);
};

const featureWriteStatement = (
  key: AdminFeatureKey,
  enabled: boolean,
  whenSql: string,
  whenArgs: readonly string[] = [],
): SqlStatement => featureField(key, enabled).statement(whenSql, whenArgs);

const syncFeatureSetting = (stored: string): void => {
  syncStoredSetting(CONFIG_KEYS.ENABLED_FEATURES, (values) =>
    values.set(CONFIG_KEYS.ENABLED_FEATURES, stored),
  );
  setSnapshotField(CONFIG_KEYS.ENABLED_FEATURES, stored);
};

const writeAdminFeatureEnabled = async (
  key: AdminFeatureKey,
  enabled: boolean,
): Promise<boolean> => {
  const inUseSql = FEATURES_BY_KEY[key].inUseSql;
  const stored = await featureField(key, enabled).write(
    !enabled && inUseSql ? `NOT (${inUseSql})` : "TRUE",
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
    "SELECT value FROM settings WHERE key = ?",
    [CONFIG_KEYS.LISTING_DEFAULTS],
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

const listingDefaultsUnchanged = (
  current: string | null,
): { args: string[]; sql: string } =>
  current === null
    ? {
        args: [],
        sql: `NOT EXISTS (
          SELECT 1 FROM settings WHERE key = '${CONFIG_KEYS.LISTING_DEFAULTS}'
        )`,
      }
    : {
        args: [current],
        sql: `EXISTS (
          SELECT 1 FROM settings
          WHERE key = '${CONFIG_KEYS.LISTING_DEFAULTS}' AND value = ?
        )`,
      };

const logisticsDisableStatements = (
  prepared: PreparedLogisticsDefault,
): { featureResultIndex: number; statements: SqlStatement[] } => {
  const unchanged = listingDefaultsUnchanged(prepared.current);
  const statements: SqlStatement[] = [
    requireSettingCondition(unchanged.sql, unchanged.args),
  ];
  if (prepared.nextEncrypted !== null) {
    statements.push({
      args: [
        prepared.nextEncrypted,
        CONFIG_KEYS.LISTING_DEFAULTS,
        prepared.current,
      ],
      sql: "UPDATE settings SET value = ? WHERE key = ? AND value = ?",
    });
  }
  statements.push(
    requireSettingCondition(`NOT (${FEATURES_BY_KEY.logistics.inUseSql})`),
  );
  const featureResultIndex = statements.length;
  statements.push(
    featureWriteStatement("logistics", false, "TRUE"),
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
  parseEnabledFeatures(row.value);
  syncLogisticsDisable(prepared, row.value);
};

const disableLogisticsFeature = async (): Promise<boolean> => {
  for (let attempt = 0; attempt < JSON_WRITE_ATTEMPTS; attempt += 1) {
    const prepared = await prepareLogisticsDefault();
    try {
      await saveLogisticsDisable(prepared);
      return true;
    } catch (error) {
      if (!isRequiredSettingWriteFailure(error)) throw error;
      if ((await prepareLogisticsDefault()).current !== prepared.current) {
        continue;
      }
      return false;
    }
  }
  throw new Error("Listing defaults changed too often to disable Logistics");
};

/** Change one feature without replacing other feature choices that may have
 * been saved at the same time. Logistics also removes its listing default in
 * the same transaction when it is disabled. */
export const setAdminFeatureEnabled = (
  key: AdminFeatureKey,
  enabled: boolean,
): Promise<boolean> =>
  key === "logistics" && !enabled
    ? disableLogisticsFeature()
    : writeAdminFeatureEnabled(key, enabled);
