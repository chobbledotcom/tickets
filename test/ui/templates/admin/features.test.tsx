import { assert } from "@std/assert";
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
import { says } from "#test-utils/says.ts";

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
      says(html, `href="/admin/features/${feature.slug}"`);
    }
    says(
      html,
      '<td><a href="/admin/features/attributes">Attributes</a></td><td>Enabled</td>',
    );
    says(
      html,
      '<td><a href="/admin/features/site">Site</a></td><td>Disabled</td>',
    );
  });

  test("renders an enabled feature as an editable yes-no form", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderFeature({ enabled: true });

    says(html, 'action="/admin/features/attributes"');
    says(html, '<input checked name="enabled" type="radio" value="true">');
    says(html, '<input name="enabled" type="radio" value="false">');
    says(html, "Save feature");
    assert(!html.includes("This feature is in use."));
  });

  test("shows an in-use feature status without a form", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderFeature({ enabled: true, inUse: true });

    says(html, "<strong>Status:</strong> Enabled");
    says(html, "This feature is in use.");
    says(html, "Remove its saved items before you disable it.");
    assert(!html.includes('action="/admin/features/attributes"'));
    assert(!html.includes('name="enabled"'));
  });

  test("shows a disabled read-only status without in-use help or controls", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = renderFeature();

    says(html, "<strong>Status:</strong> Disabled");
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

    says(html, '<div class="success" role="alert">');
    says(html, "Attributes enabled.");
    expect(html).toMatch(
      /<div(?=[^>]*class="error")(?=[^>]*role="alert")[^>]*>/,
    );
    says(html, "Choose a value.");
  });
});
