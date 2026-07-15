import * as v from "valibot";
import {
  type EnabledFeatures,
  serializeEnabledFeatures,
} from "#shared/admin-features.ts";
import { bareSchemaMigration } from "./define.ts";

const StoredBooleanSchema = v.union([v.literal(0), v.literal(1)]);
const ExistingFeatureUsageSchema = v.object({
  apiKeys: StoredBooleanSchema,
  logistics: StoredBooleanSchema,
  modifiers: StoredBooleanSchema,
  servingEvents: StoredBooleanSchema,
});

const asBoolean = (value: 0 | 1): boolean => value === 1;

export default bareSchemaMigration(
  "2026-07-15_enabled_features",
  "Move admin feature visibility into one plain enabled-features setting.",
  async ({ getDb }) => {
    const result = await getDb().execute(`
      SELECT
        EXISTS (SELECT 1 FROM modifiers AS modifier) AS modifiers,
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
        ) AS servingEvents
    `);
    const row = v.parse(ExistingFeatureUsageSchema, result.rows[0]);
    const features: EnabledFeatures = {
      apiKeys: asBoolean(row.apiKeys),
      logistics: asBoolean(row.logistics),
      modifiers: asBoolean(row.modifiers),
      money: false,
      servingEvents: asBoolean(row.servingEvents),
    };
    await getDb().batch([
      {
        args: [serializeEnabledFeatures(features)],
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('enabled_features', ?)",
      },
      "DELETE FROM settings WHERE key = 'has_logistics'",
    ]);
  },
);
