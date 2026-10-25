import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  ADMIN_FEATURES,
  parseEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { adminFeaturePage, FeaturesTable } from "#templates/admin/features.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";

const FEATURE = ADMIN_FEATURES.find((feature) => feature.key === "attributes");
if (!FEATURE) throw new Error("Attributes feature definition was not found");

const renderFeature = (
  overrides: Partial<Parameters<typeof adminFeaturePage>[0]> = {},
): string =>
  adminFeaturePage({
    enabled: false,
    feature: FEATURE,
    inUse: false,
    session: OWNER_SESSION,
    theme: "light",
    ...overrides,
  });

describe("admin feature templates", () => {
  beforeAll(setupAdminPageTest);

  test("lists every feature with its configured status and detail link", () => {
    const enabledFeatures = setFeatureEnabled(
      parseEnabledFeatures(""),
      FEATURE.key,
      true,
    );
    const html = String(FeaturesTable({ enabledFeatures }));

    for (const feature of ADMIN_FEATURES) {
      assertStringIncludes(html, `href="/admin/features/${feature.slug}"`);
    }
    assertStringIncludes(
      html,
      '<td><a href="/admin/features/attributes">Attributes</a></td><td>Enabled</td>',
    );
    assertStringIncludes(
      html,
      '<td><a href="/admin/features/site">Site</a></td><td>Disabled</td>',
    );
  });

  test("renders an enabled feature as an editable yes-no form", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderFeature({ enabled: true });

    assertStringIncludes(html, 'action="/admin/features/attributes"');
    assertStringIncludes(
      html,
      '<input checked name="enabled" type="radio" value="true">',
    );
    assertStringIncludes(
      html,
      '<input name="enabled" type="radio" value="false">',
    );
    assertStringIncludes(html, "Save feature");
    assert(!html.includes("This feature is in use."));
  });

  test("shows an in-use feature status without a form", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderFeature({ enabled: true, inUse: true });

    assertStringIncludes(html, "<strong>Status:</strong> Enabled");
    assertStringIncludes(html, "This feature is in use.");
    assertStringIncludes(html, "Remove its saved items before you disable it.");
    assert(!html.includes('action="/admin/features/attributes"'));
    assert(!html.includes('name="enabled"'));
  });

  test("shows a disabled read-only status without in-use help or controls", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = renderFeature();

    assertStringIncludes(html, "<strong>Status:</strong> Disabled");
    assert(!html.includes("This feature is in use."));
    assert(!html.includes('action="/admin/features/attributes"'));
    assert(!html.includes('name="enabled"'));
  });

  test("renders submitted error and success notices", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderFeature({
      error: "Choose a value.",
      success: "Attributes enabled.",
    });

    assertStringIncludes(html, '<div class="success" role="alert">');
    assertStringIncludes(html, "Attributes enabled.");
    expect(html).toMatch(
      /<div(?=[^>]*class="error")(?=[^>]*role="alert")[^>]*>/,
    );
    assertStringIncludes(html, "Choose a value.");
  });
});
