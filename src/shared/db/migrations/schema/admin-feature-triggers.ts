import { enabledFeaturesAreValidSql } from "#db/admin-feature-sql.ts";
import {
  type SqlStatement,
  sql,
  sqlLiteral,
  sqlName,
  sqlNames,
} from "#db/sql.ts";
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
  when?: SqlStatement;
};

type FeatureWriteSource = FeatureWriteSourceBase &
  ({ event: "INSERT" } | { columns: readonly string[]; event: "UPDATE" });

const FEATURE_WRITE_SOURCES: FeatureWriteSource[] = [
  {
    event: "INSERT",
    feature: "attributes",
    name: "trg_admin_feature_attributes_insert",
    table: "attributes",
  },
  {
    columns: ["name", "sort_order"],
    event: "UPDATE",
    feature: "attributes",
    name: "trg_admin_feature_attributes_update",
    table: "attributes",
  },
  {
    event: "INSERT",
    feature: "questions",
    name: "trg_admin_feature_questions_insert",
    table: "questions",
  },
  {
    columns: ["text", "sort_order", "display_type", "assign_all"],
    event: "UPDATE",
    feature: "questions",
    name: "trg_admin_feature_questions_update",
    table: "questions",
  },
  {
    event: "INSERT",
    feature: "modifiers",
    name: "trg_admin_feature_modifiers_insert",
    table: "modifiers",
  },
  {
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
    event: "UPDATE",
    feature: "modifiers",
    name: "trg_admin_feature_modifiers_update",
    table: "modifiers",
  },
  {
    event: "INSERT",
    feature: "logistics",
    name: "trg_admin_feature_logistics_agents_insert",
    table: "logistics_agents",
  },
  {
    columns: ["name"],
    event: "UPDATE",
    feature: "logistics",
    name: "trg_admin_feature_logistics_agents_update",
    table: "logistics_agents",
  },
  {
    columns: ["uses_logistics"],
    event: "INSERT",
    feature: "logistics",
    name: "trg_admin_feature_logistics_listings_insert",
    table: "listings",
    when: sql`NEW.uses_logistics = 1`,
  },
  {
    columns: ["uses_logistics"],
    event: "UPDATE",
    feature: "logistics",
    name: "trg_admin_feature_logistics_listings_update",
    table: "listings",
    when: sql`NEW.uses_logistics = 1`,
  },
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
    when: sql`NEW.kind = 'servicing'`,
  },
  {
    columns: ["kind", "pii_blob"],
    event: "UPDATE",
    feature: "servicing",
    name: "trg_admin_feature_servicing_update",
    table: "attendees",
    when: sql`NEW.kind = 'servicing'`,
  },
];

const initialFeaturesFor = (feature: AdminFeatureKey): string =>
  serializeEnabledFeatures(
    setFeatureEnabled(parseEnabledFeatures(""), feature, true),
  );

const triggerEvent = (source: FeatureWriteSource): SqlStatement =>
  source.event === "UPDATE"
    ? sql`AFTER UPDATE OF ${sqlNames(source.columns)}`
    : sql`AFTER INSERT`;

const featureWriteTrigger = (source: FeatureWriteSource): Trigger => ({
  name: source.name,
  sql: sql`CREATE TRIGGER IF NOT EXISTS ${sqlName(source.name)}
${triggerEvent(source)} ON ${sqlName(source.table)}
FOR EACH ROW${source.when ? sql`\nWHEN ${source.when}` : sql``}
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM settings
    WHERE key = ${sqlLiteral(CONFIG_KEYS.ENABLED_FEATURES)}
      AND NOT (${enabledFeaturesAreValidSql(sql`value`)})
  ) THEN RAISE(ABORT, 'enabled feature setting is invalid') END;
  INSERT INTO settings (key, value)
  VALUES (${sqlLiteral(CONFIG_KEYS.ENABLED_FEATURES)}, ${sqlLiteral(initialFeaturesFor(source.feature))})
  ON CONFLICT(key) DO UPDATE SET
    value = json_set(value, ${sqlLiteral(`$.${source.feature}`)}, json('true'));
  INSERT INTO settings (key, value)
  VALUES (${sqlLiteral(CONFIG_KEYS.SETTINGS_VERSION)}, '1')
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
