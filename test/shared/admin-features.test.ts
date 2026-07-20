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

describe("admin features", () => {
  test("defines the complete feature list in display order", () => {
    expect(ADMIN_FEATURES).toEqual([
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
    ]);
  });

  test("defaults every feature to disabled", () => {
    expect(DEFAULT_ENABLED_FEATURES).toEqual({
      apiKeys: false,
      attributes: false,
      logistics: false,
      modifiers: false,
      money: false,
      questions: false,
      servicing: false,
      site: false,
    });
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

  test("rejects malformed, partial, extra, and non-boolean settings", () => {
    const invalidValues = [
      "not json",
      JSON.stringify({ ...DEFAULT_ENABLED_FEATURES, money: "true" }),
      JSON.stringify({ money: false }),
      JSON.stringify({ ...DEFAULT_ENABLED_FEATURES, unknown: false }),
    ];
    for (const value of invalidValues) {
      expect(() => parseEnabledFeatures(value), value).toThrow();
    }
  });

  test("identifies an incomplete setting without retaining its value", () => {
    let thrown: unknown;
    try {
      parseEnabledFeatures(JSON.stringify({ money: false }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message:
        "Invalid stored JSON in settings.enabled_features: Stored value does not match its schema",
    });
    expect((thrown as Error).cause).toBeUndefined();
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
