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
import { queryOne } from "#shared/db/client.ts";
import { writeBooleanJsonField } from "#shared/db/settings/json-field.ts";
import { settings } from "#shared/db/settings.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

const UsageRowSchema = v.object({ value: v.string() });

const FEATURES_BY_KEY = Object.fromEntries(
  ADMIN_FEATURES.map((feature) => [feature.key, feature]),
) as Record<AdminFeatureKey, AdminFeatureDefinition>;

const usageJsonEntry = (feature: AdminFeatureDefinition): string =>
  `'${feature.key}', json(IIF(${feature.inUseSql ?? "FALSE"}, 'true', 'false'))`;

/** Read every feature's usage in one database round trip. Money deliberately
 * has no usage rule: its switch only controls display and is always changeable. */
export const getAdminFeatureUsage = async (): Promise<EnabledFeatures> => {
  const row = v.parse(
    UsageRowSchema,
    await queryOne<unknown>(
      `SELECT json_object(${ADMIN_FEATURES.map(usageJsonEntry).join(", ")}) AS value`,
    ),
  );
  return parseEnabledFeatures(row.value);
};

/** Change one feature without replacing other feature choices that may have
 * been saved at the same time. */
export const setAdminFeatureEnabled = async (
  key: AdminFeatureKey,
  enabled: boolean,
): Promise<boolean> => {
  const initialValue = serializeEnabledFeatures(
    setFeatureEnabled(parseEnabledFeatures(""), key, enabled),
  );
  const inUseSql = FEATURES_BY_KEY[key].inUseSql;
  const stored = await writeBooleanJsonField(
    CONFIG_KEYS.ENABLED_FEATURES,
    initialValue,
    `$.${key}`,
    enabled,
    !enabled && inUseSql ? `NOT (${inUseSql})` : "TRUE",
  );
  if (stored === null) return false;
  parseEnabledFeatures(stored);
  return true;
};

/** Turn a feature on after a successful feature write. */
export const ensureAdminFeatureEnabled = async (
  key: AdminFeatureKey,
): Promise<void> => {
  if (settings.features[key]) return;
  await setAdminFeatureEnabled(key, true);
};

interface AdminFeatureWriteSteps {
  afterCreate: () => Promise<void>;
  beforeWrite: () => Promise<void>;
}

/** The before/after steps that keep a feature visible around a saved record. */
export const adminFeatureWriteSteps = (
  key: AdminFeatureKey,
): AdminFeatureWriteSteps => ({
  afterCreate: async () => {
    await setAdminFeatureEnabled(key, true);
  },
  beforeWrite: () => ensureAdminFeatureEnabled(key),
});

/** Keep the feature visible around a new saved record. The first enable makes a
 * failed feature write block creation; the second closes a race with an operator
 * disabling it before the record exists. */
export const createWithAdminFeature = async <T>(
  key: AdminFeatureKey,
  create: () => Promise<T>,
): Promise<T> => {
  const steps = adminFeatureWriteSteps(key);
  await steps.beforeWrite();
  const result = await create();
  await steps.afterCreate();
  return result;
};
