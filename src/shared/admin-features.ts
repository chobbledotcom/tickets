import * as v from "valibot";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

/**
 * The admin features operators can choose to show. This one registry drives the
 * stored JSON shape, settings table, detail routes, copy, usage checks, and nav
 * visibility, so adding a feature means adding one complete entry here.
 */
export const ADMIN_FEATURES = [
  {
    descriptionKey: "features.site.description",
    inUseSql: null,
    key: "site",
    labelKey: "features.site.name",
    slug: "site",
  },
  {
    descriptionKey: "features.attributes.description",
    inUseSql: "EXISTS (SELECT 1 FROM attributes AS attribute)",
    key: "attributes",
    labelKey: "features.attributes.name",
    slug: "attributes",
  },
  {
    descriptionKey: "features.questions.description",
    inUseSql: "EXISTS (SELECT 1 FROM questions AS question)",
    key: "questions",
    labelKey: "features.questions.name",
    slug: "questions",
  },
  {
    descriptionKey: "features.modifiers.description",
    inUseSql: "EXISTS (SELECT 1 FROM modifiers AS modifier)",
    key: "modifiers",
    labelKey: "features.modifiers.name",
    slug: "modifiers",
  },
  {
    descriptionKey: "features.logistics.description",
    inUseSql:
      "EXISTS (SELECT 1 FROM logistics_agents AS logisticsAgent) OR EXISTS (SELECT 1 FROM listings AS listing WHERE listing.uses_logistics = 1)",
    key: "logistics",
    labelKey: "features.logistics.name",
    slug: "logistics",
  },
  {
    descriptionKey: "features.api_keys.description",
    inUseSql: "EXISTS (SELECT 1 FROM api_keys AS apiKey)",
    key: "apiKeys",
    labelKey: "features.api_keys.name",
    slug: "api-keys",
  },
  {
    descriptionKey: "features.servicing.description",
    inUseSql:
      "EXISTS (SELECT 1 FROM attendees AS attendee WHERE attendee.kind = 'servicing')",
    key: "servicing",
    labelKey: "features.servicing.name",
    slug: "servicing",
  },
  {
    descriptionKey: "features.money.description",
    inUseSql: null,
    key: "money",
    labelKey: "features.money.name",
    slug: "money",
  },
] as const;

export type AdminFeatureDefinition = (typeof ADMIN_FEATURES)[number];
export type AdminFeatureKey = AdminFeatureDefinition["key"];
export type EnabledFeatures = { [Key in AdminFeatureKey]: boolean };

const FEATURE_KEYS = ADMIN_FEATURES.map(
  (feature) => feature.key,
) as AdminFeatureKey[];

const EnabledFeaturesSchema = v.pipe(
  v.record(v.picklist(FEATURE_KEYS), v.boolean()),
  v.check(
    (features) => FEATURE_KEYS.every((key) => Object.hasOwn(features, key)),
    "Every admin feature must have an enabled value",
  ),
);
const enabledFeaturesJson = defineStoredJson(EnabledFeaturesSchema);

const DEFAULT_ENABLED_FEATURES = Object.freeze(
  Object.fromEntries(FEATURE_KEYS.map((key) => [key, false])),
) as EnabledFeatures;

/** Parse the plain JSON setting. An absent row is the expected all-hidden
 * default; malformed or incomplete stored JSON is an error. */
export const parseEnabledFeatures = (value: string): EnabledFeatures =>
  value === ""
    ? DEFAULT_ENABLED_FEATURES
    : (enabledFeaturesJson.read(
        value,
        "settings.enabled_features",
      ) as EnabledFeatures);

export const serializeEnabledFeatures = (features: EnabledFeatures): string =>
  enabledFeaturesJson.write(features, "settings.enabled_features");

export const setFeatureEnabled = (
  features: EnabledFeatures,
  key: AdminFeatureKey,
  enabled: boolean,
): EnabledFeatures => ({ ...features, [key]: enabled });

/** Features with saved records remain shown even if their stored preference is
 * false. Money's usage value is always false, so it remains freely toggleable. */
export const enabledFeaturesWithUsage = (
  configured: EnabledFeatures,
  usage: EnabledFeatures,
): EnabledFeatures =>
  Object.fromEntries(
    ADMIN_FEATURES.map(({ key }) => [key, configured[key] || usage[key]]),
  ) as EnabledFeatures;

export const featureBySlug = (slug: string): AdminFeatureDefinition | null =>
  ADMIN_FEATURES.find((feature) => feature.slug === slug) ?? null;
