import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";

const state = {
  businessEmail: "ops@example.com",
  customCss: "body { color: red; }",
  embedHosts: "example.com",
  externalOrderEnabled: true,
  showPublicApi: true,
  termsAndConditions: "Be kind.",
};

const htmlFor = (name: keyof typeof SETTINGS_FORMS): string =>
  String(settingsForm(SETTINGS_FORMS[name], state));

describe("settingsForm", () => {
  test("renders a text setting from the schema", () => {
    const html = htmlFor("businessEmail");

    expect(html).toContain('action="/admin/settings/business-email"');
    expect(html).toContain('id="settings-business-email"');
    expect(html).toContain('name="business_email"');
    expect(html).toContain('type="email"');
    expect(html).toContain('value="ops@example.com"');
  });

  test("renders an empty text value when the state has no value", () => {
    const html = String(settingsForm(SETTINGS_FORMS.businessEmail, {}));

    expect(html).toContain('name="business_email"');
    expect(html).toContain('value=""');
  });

  test("renders schema footer copy for text settings", () => {
    const html = htmlFor("embedHosts");

    expect(html).toContain('name="embed_hosts"');
    expect(html).toContain("Use *.example.com to allow all subdomains");
  });

  test("renders a textarea setting with its schema options", () => {
    const html = htmlFor("terms");

    expect(html).toContain('action="/admin/settings/terms"');
    expect(html).toContain('name="terms_and_conditions"');
    expect(html).toContain("data-markdown-preview");
    expect(html).toContain("Be kind.");
    expect(html).toContain("Formatting");
  });

  test("renders trusted html description copy from the schema", () => {
    const html = htmlFor("showPublicApi");

    expect(html).toContain('href="/admin/guide#api"');
    expect(html).toContain("API guide");
  });

  test("renders a boolean setting from the schema", () => {
    const html = htmlFor("externalOrder");

    expect(html).toContain('action="/admin/settings/external-order"');
    expect(html).toContain('name="external_order_enabled"');
    expect(html).toContain(
      '<input checked name="external_order_enabled" type="radio" value="true">',
    );
  });
});
