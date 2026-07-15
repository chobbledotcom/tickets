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
    expect(ADMIN_FEATURES.map(({ key, slug }) => ({ key, slug }))).toEqual([
      { key: "modifiers", slug: "modifiers" },
      { key: "logistics", slug: "logistics" },
      { key: "apiKeys", slug: "api-keys" },
      { key: "servingEvents", slug: "serving-events" },
      { key: "money", slug: "money" },
    ]);
  });

  test("defaults every feature to disabled", () => {
    expect(DEFAULT_ENABLED_FEATURES).toEqual({
      apiKeys: false,
      logistics: false,
      modifiers: false,
      money: false,
      servingEvents: false,
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

  test("explains why an incomplete setting is invalid", () => {
    let thrown: unknown;
    try {
      parseEnabledFeatures(JSON.stringify({ money: false }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message: "Every admin feature must have an enabled value",
    });
  });

  test("finds a feature by slug and returns null for an unknown slug", () => {
    expect(featureBySlug("serving-events")?.key).toBe("servingEvents");
    expect(featureBySlug("unknown")).toBeNull();
  });
});
