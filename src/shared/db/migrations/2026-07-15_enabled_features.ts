import * as v from "valibot";
import {
  type EnabledFeatures,
  parseEnabledFeatures,
  serializeEnabledFeatures,
} from "#shared/admin-features.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { bareSchemaMigration } from "./define.ts";

const StoredBooleanSchema = v.union([v.literal(0), v.literal(1)]);
const ExistingFeatureUsageSchema = v.object({
  apiKeys: StoredBooleanSchema,
  attributes: StoredBooleanSchema,
  configured: v.string(),
  logistics: StoredBooleanSchema,
  modifiers: StoredBooleanSchema,
  questions: StoredBooleanSchema,
  servicing: StoredBooleanSchema,
  site: StoredBooleanSchema,
});

const asBoolean = (value: 0 | 1): boolean => value === 1;

export default bareSchemaMigration(
  "2026-07-15_enabled_features",
  "Move admin feature visibility into one plain enabled-features setting.",
  async ({ getDb }) => {
    const result = await getDb().execute(`
      SELECT
        EXISTS (SELECT 1 FROM attributes AS attribute) AS attributes,
        EXISTS (SELECT 1 FROM questions AS question) AS questions,
        EXISTS (SELECT 1 FROM modifiers AS modifier) AS modifiers,
        COALESCE(
          (
            SELECT featureSetting.value
            FROM settings AS featureSetting
            WHERE featureSetting.key = 'enabled_features'
            LIMIT 1
          ),
          ''
        ) AS configured,
        (
          EXISTS (SELECT 1 FROM logistics_agents AS logisticsAgent)
          OR EXISTS (
            SELECT 1
            FROM listings AS listing
            WHERE listing.uses_logistics = 1
          )
          OR EXISTS (
            SELECT 1
            FROM settings AS setting
            WHERE setting.key = 'has_logistics' AND setting.value = 'true'
          )
        ) AS logistics,
        EXISTS (SELECT 1 FROM api_keys AS apiKey) AS apiKeys,
        EXISTS (
          SELECT 1
          FROM attendees AS attendee
          WHERE attendee.kind = 'servicing'
        ) AS servicing,
        (
          EXISTS (
            SELECT 1
            FROM settings AS legacySetting
            WHERE legacySetting.key = 'show_public_site'
              AND legacySetting.value = 'true'
          )
        ) AS site
    `);
    const row = v.parse(ExistingFeatureUsageSchema, result.rows[0]);
    const configured = parseEnabledFeatures(row.configured);
    const features: EnabledFeatures = {
      apiKeys: configured.apiKeys || asBoolean(row.apiKeys),
      attributes: configured.attributes || asBoolean(row.attributes),
      logistics: configured.logistics || asBoolean(row.logistics),
      modifiers: configured.modifiers || asBoolean(row.modifiers),
      money: configured.money,
      questions: configured.questions || asBoolean(row.questions),
      servicing: configured.servicing || asBoolean(row.servicing),
      site: configured.site || asBoolean(row.site),
    };
    await getDb().batch([
      {
        args: [
          CONFIG_KEYS.ENABLED_FEATURES,
          serializeEnabledFeatures(features),
        ],
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      },
      "DELETE FROM settings WHERE key IN ('has_logistics', 'show_public_site')",
    ]);
  },
);
