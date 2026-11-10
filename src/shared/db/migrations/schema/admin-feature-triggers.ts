import { enabledFeaturesAreValidSql } from "#db/admin-feature-sql.ts";
import {
  type AdminFeatureKey,
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import type { Trigger } from "./types.ts";

type FeatureWriteSourceBase = {
  columns?: readonly string[];
  feature: AdminFeatureKey;
  name: string;
  table: string;
  when?: string;
};

type FeatureWriteSource = FeatureWriteSourceBase &
  ({ event: "INSERT" } | { columns: readonly string[]; event: "UPDATE" });

/** Any saved row of `table` puts `feature` in use: a new row, or an edit of
 * one of `columns`. */
const recordSources = (
  feature: AdminFeatureKey,
  table: string,
  columns: readonly string[],
): FeatureWriteSource[] => [
  {
    event: "INSERT",
    feature,
    name: `trg_admin_feature_${table}_insert`,
    table,
  },
  {
    columns,
    event: "UPDATE",
    feature,
    name: `trg_admin_feature_${table}_update`,
    table,
  },
];

/** A listing saved with `column` set puts `feature` in use, on create and on
 * edit. */
const listingColumnSources = (
  feature: AdminFeatureKey,
  column: string,
  inUse: string,
): FeatureWriteSource[] =>
  (["INSERT", "UPDATE"] as const).map((event) => ({
    columns: [column],
    event,
    feature,
    name: `trg_admin_feature_${feature}_listings_${event.toLowerCase()}`,
    table: "listings",
    when: `NEW.${column} ${inUse}`,
  }));

const FEATURE_WRITE_SOURCES: FeatureWriteSource[] = [
  ...recordSources("attributes", "attributes", ["name", "sort_order"]),
  ...recordSources("questions", "questions", [
    "text",
    "sort_order",
    "display_type",
    "assign_all",
  ]),
  ...recordSources("modifiers", "modifiers", [
    "name",
    "calc_kind",
    "calc_value",
    "direction",
    "active",
    "trigger",
    "code",
    "code_index",
    "scope",
    "stock",
    "max_per_order",
    "min_subtotal",
    "min_visits",
  ]),
  ...recordSources("logistics", "logistics_agents", ["name"]),
  ...listingColumnSources("logistics", "uses_logistics", "= 1"),
  {
    event: "INSERT",
    feature: "apiKeys",
    name: "trg_admin_feature_api_keys_insert",
    table: "api_keys",
  },
  {
    columns: ["kind"],
    event: "INSERT",
    feature: "servicing",
    name: "trg_admin_feature_servicing_insert",
    table: "attendees",
    when: "NEW.kind = 'servicing'",
  },
  {
    columns: ["kind", "pii_blob"],
    event: "UPDATE",
    feature: "servicing",
    name: "trg_admin_feature_servicing_update",
    table: "attendees",
    when: "NEW.kind = 'servicing'",
  },
  ...listingColumnSources("subscriptions", "recurring_price", "> 0"),
];

const initialFeaturesFor = (feature: AdminFeatureKey): string =>
  serializeEnabledFeatures(
    setFeatureEnabled(parseEnabledFeatures(""), feature, true),
  );

const triggerEvent = (source: FeatureWriteSource): string =>
  source.event === "UPDATE"
    ? `AFTER UPDATE OF ${source.columns.join(", ")}`
    : "AFTER INSERT";

const featureWriteTrigger = (source: FeatureWriteSource): Trigger => ({
  name: source.name,
  sql: `CREATE TRIGGER IF NOT EXISTS ${source.name}
${triggerEvent(source)} ON ${source.table}
FOR EACH ROW${source.when ? `\nWHEN ${source.when}` : ""}
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM settings
    WHERE key = '${CONFIG_KEYS.ENABLED_FEATURES}'
      AND NOT (${enabledFeaturesAreValidSql("value")})
  ) THEN RAISE(ABORT, 'enabled feature setting is invalid') END;
  INSERT INTO settings (key, value)
  VALUES ('${CONFIG_KEYS.ENABLED_FEATURES}', '${initialFeaturesFor(source.feature)}')
  ON CONFLICT(key) DO UPDATE SET
    value = json_set(value, '$.${source.feature}', json('true'));
  INSERT INTO settings (key, value)
  VALUES ('${CONFIG_KEYS.SETTINGS_VERSION}', '1')
  ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END`,
  table: source.table,
  uses: {
    [source.table]: source.columns ?? [],
    settings: ["key", "value"],
  },
});

export const ADMIN_FEATURE_TRIGGERS =
  FEATURE_WRITE_SOURCES.map(featureWriteTrigger);

export const ADMIN_FEATURE_TRIGGER_NAMES = ADMIN_FEATURE_TRIGGERS.map(
  ({ name }) => name,
);
