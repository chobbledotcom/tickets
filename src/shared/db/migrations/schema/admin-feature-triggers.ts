import {
  ADMIN_FEATURES,
  type AdminFeatureKey,
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import type { Trigger } from "./types.ts";

type FeatureWriteSource = {
  action: string;
  columns?: readonly string[];
  feature: AdminFeatureKey;
  name: string;
  table: string;
  when?: string;
};

const FEATURE_WRITE_SOURCES: FeatureWriteSource[] = [
  {
    action: "AFTER INSERT",
    feature: "attributes",
    name: "trg_admin_feature_attributes_insert",
    table: "attributes",
  },
  {
    action: "AFTER UPDATE OF name, sort_order",
    columns: ["name", "sort_order"],
    feature: "attributes",
    name: "trg_admin_feature_attributes_update",
    table: "attributes",
  },
  {
    action: "AFTER INSERT",
    feature: "questions",
    name: "trg_admin_feature_questions_insert",
    table: "questions",
  },
  {
    action: "AFTER UPDATE OF text, sort_order, display_type, assign_all",
    columns: ["text", "sort_order", "display_type", "assign_all"],
    feature: "questions",
    name: "trg_admin_feature_questions_update",
    table: "questions",
  },
  {
    action: "AFTER INSERT",
    feature: "modifiers",
    name: "trg_admin_feature_modifiers_insert",
    table: "modifiers",
  },
  {
    action:
      "AFTER UPDATE OF name, calc_kind, calc_value, direction, active, trigger, code, code_index, scope, stock, max_per_order, min_subtotal, min_visits",
    columns: [
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
    ],
    feature: "modifiers",
    name: "trg_admin_feature_modifiers_update",
    table: "modifiers",
  },
  {
    action: "AFTER INSERT",
    feature: "logistics",
    name: "trg_admin_feature_logistics_agents_insert",
    table: "logistics_agents",
  },
  {
    action: "AFTER UPDATE OF name",
    columns: ["name"],
    feature: "logistics",
    name: "trg_admin_feature_logistics_agents_update",
    table: "logistics_agents",
  },
  {
    action: "AFTER INSERT",
    columns: ["uses_logistics"],
    feature: "logistics",
    name: "trg_admin_feature_logistics_listings_insert",
    table: "listings",
    when: "NEW.uses_logistics = 1",
  },
  {
    action: "AFTER UPDATE OF uses_logistics",
    columns: ["uses_logistics"],
    feature: "logistics",
    name: "trg_admin_feature_logistics_listings_update",
    table: "listings",
    when: "NEW.uses_logistics = 1",
  },
  {
    action: "AFTER INSERT",
    feature: "apiKeys",
    name: "trg_admin_feature_api_keys_insert",
    table: "api_keys",
  },
  {
    action: "AFTER INSERT",
    columns: ["kind"],
    feature: "servicing",
    name: "trg_admin_feature_servicing_insert",
    table: "attendees",
    when: "NEW.kind = 'servicing'",
  },
  {
    action: "AFTER UPDATE OF kind, pii_blob",
    columns: ["kind", "pii_blob"],
    feature: "servicing",
    name: "trg_admin_feature_servicing_update",
    table: "attendees",
    when: "NEW.kind = 'servicing'",
  },
];

const validFeatureJsonSql = ADMIN_FEATURES.map(
  ({ key }) => `json_type(value, '$.${key}') IN ('true', 'false')`,
).join("\n    AND ");

const initialFeaturesFor = (feature: AdminFeatureKey): string =>
  serializeEnabledFeatures(
    setFeatureEnabled(parseEnabledFeatures(""), feature, true),
  );

const featureWriteTrigger = (source: FeatureWriteSource): Trigger => ({
  name: source.name,
  sql: `CREATE TRIGGER IF NOT EXISTS ${source.name}
${source.action} ON ${source.table}
FOR EACH ROW${source.when ? `\nWHEN ${source.when}` : ""}
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM settings
    WHERE key = '${CONFIG_KEYS.ENABLED_FEATURES}'
      AND CASE WHEN json_valid(value)
        THEN COALESCE(${validFeatureJsonSql}, 0)
        ELSE 0
      END = 0
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
