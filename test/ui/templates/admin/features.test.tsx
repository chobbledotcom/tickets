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
      expect(html).toContain(`href="/admin/features/${feature.slug}"`);
    }
    expect(html).toContain(
      '<td><a href="/admin/features/attributes">Attributes</a></td><td>Enabled</td>',
    );
    expect(html).toContain(
      '<td><a href="/admin/features/site">Site</a></td><td>Disabled</td>',
    );
  });

  test("renders an enabled feature as an editable yes-no form", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderFeature({ enabled: true });

    expect(html).toContain('action="/admin/features/attributes"');
    expect(html).toContain(
      '<input checked name="enabled" type="radio" value="true">',
    );
    expect(html).toContain('<input name="enabled" type="radio" value="false">');
    expect(html).toContain("Save feature");
    expect(html).not.toContain("This feature is in use.");
  });

  test("shows an in-use feature status without a form", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderFeature({ enabled: true, inUse: true });

    expect(html).toContain("<strong>Status:</strong> Enabled");
    expect(html).toContain("This feature is in use.");
    expect(html).toContain("Remove its saved items before you disable it.");
    expect(html).not.toContain('action="/admin/features/attributes"');
    expect(html).not.toContain('name="enabled"');
  });

  test("shows a disabled read-only status without in-use help or controls", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = renderFeature();

    expect(html).toContain("<strong>Status:</strong> Disabled");
    expect(html).not.toContain("This feature is in use.");
    expect(html).not.toContain('action="/admin/features/attributes"');
    expect(html).not.toContain('name="enabled"');
  });

  test("renders submitted error and success notices", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = renderFeature({
      error: "Choose a value.",
      success: "Attributes enabled.",
    });

    expect(html).toContain('<div class="success" role="alert">');
    expect(html).toContain("Attributes enabled.");
    expect(html).toMatch(
      /<div(?=[^>]*class="error")(?=[^>]*role="alert")[^>]*>/,
    );
    expect(html).toContain("Choose a value.");
  });
});
