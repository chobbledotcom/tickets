import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";

const state = {
  attendeeColumnOrder: "",
  bookingFee: "1.5",
  businessEmail: "ops@example.com",
  customCss: "body { color: red; }",
  embedHosts: "example.com",
  externalOrderEnabled: true,
  listingColumnOrder: "",
  showPublicApi: true,
  termsAndConditions: "Be kind.",
  theme: "light",
  underlineLinks: false,
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
    const html = String(
      settingsForm(SETTINGS_FORMS.businessEmail, { businessEmail: undefined }),
    );

    expect(html).toContain('name="business_email"');
    expect(html).toContain('value=""');
  });

  test("uses the definition's declared formId as the form id", () => {
    // A probe definition whose formId differs from the id derived from its
    // action, so a fallback to derivation would fail this test. The registry
    // locks formId to its literal value, so the probe needs a cast.
    const probe = {
      ...SETTINGS_FORMS.businessEmail,
      formId: "settings-probe",
    } as unknown as typeof SETTINGS_FORMS.businessEmail;
    const html = String(settingsForm(probe, state));

    expect(html).toContain('id="settings-probe"');
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

describe("settingsForm multi-field forms", () => {
  const themeState = { theme: "dark", underlineLinks: false };

  test("checks exactly the radio matching the saved value", () => {
    const html = String(settingsForm(SETTINGS_FORMS.theme, themeState));

    expect(html).toContain('<fieldset class="radios">');
    expect(html).toContain(
      '<input checked name="theme" type="radio" value="dark">',
    );
    expect(html).toContain('<input name="theme" type="radio" value="light">');
  });

  test("renders the checkbox with its class and hint, unchecked", () => {
    const html = String(settingsForm(SETTINGS_FORMS.theme, themeState));

    expect(html).toContain('<label class="checkbox">');
    expect(html).toContain(
      '<input name="underline_links" type="checkbox" value="true">',
    );
    expect(html).toContain(
      "<small>Underline links everywhere, including the navigation.",
    );
  });

  test("checks the checkbox when the setting is on", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.theme, {
        theme: "light",
        underlineLinks: true,
      }),
    );

    expect(html).toContain(
      '<input checked name="underline_links" type="checkbox" value="true">',
    );
  });
});

/** A text-form probe: businessEmail's identity with schema options layered on
 *  top, standing in for definitions that use the newer schema options. The
 *  registry locks each definition to its literal values, so probes need a
 *  cast. */
const textProbe = (
  extras: object,
  copyExtras: object = {},
): typeof SETTINGS_FORMS.businessEmail => {
  const base = SETTINGS_FORMS.businessEmail;
  return {
    ...base,
    ...extras,
    copy: { ...base.copy, ...copyExtras },
  } as unknown as typeof base;
};

describe("settingsForm schema options", () => {
  test("renders no placeholder when the copy declares none", () => {
    const html = String(
      settingsForm(
        textProbe(
          {},
          { placeholderKey: undefined, placeholderText: undefined },
        ),
        state,
      ),
    );

    expect(html).toContain('name="business_email"');
    expect(html).not.toContain("placeholder");
  });

  test("builds placeholder and footer text at render time", () => {
    const html = String(
      settingsForm(
        textProbe(
          {},
          {
            footerKey: undefined,
            footerText: () => "Built footer note",
            placeholderKey: undefined,
            placeholderText: () => "Built placeholder",
          },
        ),
        state,
      ),
    );

    expect(html).toContain('placeholder="Built placeholder"');
    expect(html).toContain("<p><small>Built footer note</small></p>");
  });

  test("forwards number input constraints to the field", () => {
    const html = String(
      settingsForm(
        textProbe({
          inputType: "number",
          max: "10",
          min: "0",
          minlength: 2,
          required: true,
          step: "0.1",
        }),
        state,
      ),
    );

    const input = html.match(/<input[^>]*name="business_email"[^>]*>/)?.[0];
    expect(input).toContain('type="number"');
    expect(input).toContain('max="10"');
    expect(input).toContain('min="0"');
    expect(input).toContain('minlength="2"');
    expect(input).toContain('step="0.1"');
    expect(input).toContain("required");
  });

  test("renders a block html description without the paragraph wrapper", () => {
    const html = String(
      settingsForm(
        textProbe(
          {},
          {
            descriptionHtml: "block",
            descriptionKey: "settings.advanced.public_api_hint",
          },
        ),
        state,
      ),
    );

    const description = t("settings.advanced.public_api_hint");
    expect(html).toContain(`</h2>${description}</div>`);
    expect(html).not.toContain(`<p>${description}</p>`);
  });

  test("shows the placeholder as the value when nothing is saved yet", () => {
    const probe = textProbe({ valueFallback: "placeholder" });
    const empty = String(settingsForm(probe, { businessEmail: "" }));
    const saved = String(settingsForm(probe, state));

    expect(empty).toContain('value="contact@example.com"');
    expect(saved).toContain('value="ops@example.com"');
  });
});
