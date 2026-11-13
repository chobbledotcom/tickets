import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ADMIN_FEATURES,
  enabledFeaturesWithUsage,
  featureBySlug,
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";

const DEFAULT_ENABLED_FEATURES = parseEnabledFeatures("");

/** Each feature in display order: key, slug, catalog name, and the SQL that
 * finds its saved records. A blank SQL means the feature has no records. */
/* jscpd:ignore-start -- a list of strings, not code */
const EXPECTED_FEATURES = [
  ["site", "site", "site", ""],
  [
    "attributes",
    "attributes",
    "attributes",
    "EXISTS (SELECT 1 FROM attributes AS attribute)",
  ],
  [
    "questions",
    "questions",
    "questions",
    "EXISTS (SELECT 1 FROM questions AS question)",
  ],
  [
    "modifiers",
    "modifiers",
    "modifiers",
    "EXISTS (SELECT 1 FROM modifiers AS modifier)",
  ],
  [
    "logistics",
    "logistics",
    "logistics",
    "EXISTS (SELECT 1 FROM logistics_agents AS logisticsAgent) OR EXISTS (SELECT 1 FROM listings AS listing WHERE listing.uses_logistics = 1)",
  ],
  [
    "apiKeys",
    "api-keys",
    "api_keys",
    "EXISTS (SELECT 1 FROM api_keys AS apiKey)",
  ],
  [
    "servicing",
    "servicing",
    "servicing",
    "EXISTS (SELECT 1 FROM attendees AS attendee WHERE attendee.kind = 'servicing')",
  ],
  ["money", "money", "money", ""],
  ["externalSources", "external-sources", "external_sources", ""],
  [
    "invoices",
    "invoices",
    "invoices",
    "EXISTS (SELECT 1 FROM invoices AS invoice)",
  ],
  [
    "subscriptions",
    "subscriptions",
    "subscriptions",
    "EXISTS (SELECT 1 FROM listings AS listing WHERE listing.recurring_price > 0) OR EXISTS (SELECT 1 FROM listing_attendees AS listingAttendee WHERE listingAttendee.subscription_id != '')",
  ],
] as const;
/* jscpd:ignore-end */

const featureDefinition = ([
  key,
  slug,
  name,
  sql,
]: (typeof EXPECTED_FEATURES)[number]) => ({
  descriptionKey: `features.${name}.description`,
  inUseSql: sql === "" ? null : sql,
  key,
  labelKey: `features.${name}.name`,
  slug,
});

describe("admin features", () => {
  test("defines the complete feature list in display order", () => {
    expect(ADMIN_FEATURES).toEqual(EXPECTED_FEATURES.map(featureDefinition));
  });

  test("defaults every feature to disabled", () => {
    expect(Object.keys(DEFAULT_ENABLED_FEATURES)).toEqual(
      EXPECTED_FEATURES.map(([key]) => key),
    );
    expect(Object.values(DEFAULT_ENABLED_FEATURES)).not.toContain(true);
  });

  test("uses the defaults when the setting has not been stored", () => {
    expect(parseEnabledFeatures("")).toEqual(DEFAULT_ENABLED_FEATURES);
  });

  test("serializes and parses the complete strict setting", () => {
    const enabled = setFeatureEnabled(
      DEFAULT_ENABLED_FEATURES,
      "apiKeys",
      true,
    );
    expect(parseEnabledFeatures(serializeEnabledFeatures(enabled))).toEqual({
      ...DEFAULT_ENABLED_FEATURES,
      apiKeys: true,
    });
  });

  test("does not mutate the previous setting when one feature changes", () => {
    const enabled = setFeatureEnabled(DEFAULT_ENABLED_FEATURES, "money", true);
    expect(enabled).not.toBe(DEFAULT_ENABLED_FEATURES);
    expect(DEFAULT_ENABLED_FEATURES.money).toBe(false);
    expect(enabled.money).toBe(true);
  });

  test("shows configured features and features with saved records", () => {
    const configured = setFeatureEnabled(
      DEFAULT_ENABLED_FEATURES,
      "money",
      true,
    );
    const usage = setFeatureEnabled(
      DEFAULT_ENABLED_FEATURES,
      "modifiers",
      true,
    );
    expect(enabledFeaturesWithUsage(configured, usage)).toEqual({
      ...DEFAULT_ENABLED_FEATURES,
      modifiers: true,
      money: true,
    });
  });

  test("rejects malformed, extra, and non-boolean settings", () => {
    const invalidValues = [
      "not json",
      JSON.stringify({ ...DEFAULT_ENABLED_FEATURES, money: "true" }),
      JSON.stringify({ ...DEFAULT_ENABLED_FEATURES, unknown: false }),
    ];
    for (const value of invalidValues) {
      expect(() => parseEnabledFeatures(value), value).toThrow();
    }
  });

  test("reads a feature the stored setting lacks as off", () => {
    expect(parseEnabledFeatures(JSON.stringify({ money: true }))).toEqual({
      ...DEFAULT_ENABLED_FEATURES,
      money: true,
    });
  });

  test("identifies an invalid setting without retaining its value", () => {
    let thrown: unknown;
    try {
      parseEnabledFeatures(
        JSON.stringify({ ...DEFAULT_ENABLED_FEATURES, money: "true" }),
      );
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error;
    expect(error.message).toBe(
      "Invalid stored JSON in settings.enabled_features: Stored value does not match its schema",
    );
    // The error carries no cause, so the stored value does not travel with it.
    expect(error.cause).toBe(undefined);
  });

  test("names the setting when serialization rejects invalid features", () => {
    expect(() =>
      serializeEnabledFeatures({ money: "yes" } as unknown as Parameters<
        typeof serializeEnabledFeatures
      >[0]),
    ).toThrow(/^Invalid value for stored JSON in settings\.enabled_features$/);
  });

  test("finds a feature by slug and returns null for an unknown slug", () => {
    expect(featureBySlug("site")?.key).toBe("site");
    expect(featureBySlug("unknown")).toBeNull();
  });
});
