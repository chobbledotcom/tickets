import * as v from "valibot";
import {
  ADMIN_FEATURES,
  type AdminFeatureDefinition,
  type AdminFeatureKey,
  type EnabledFeatures,
  parseEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { queryOne } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";

const UsageRowSchema = v.object({ value: v.string() });

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

/** Turn a feature on after a successful feature write. Most writes are a no-op
 * here because operators enable the feature before using its normal UI. */
export const ensureAdminFeatureEnabled = async (
  key: AdminFeatureKey,
): Promise<void> => {
  if (settings.enabledFeatures[key]) return;
  await settings.update.enabledFeatures(
    setFeatureEnabled(settings.enabledFeatures, key, true),
  );
};
