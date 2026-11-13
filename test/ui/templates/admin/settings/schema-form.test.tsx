import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { t } from "#i18n";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const state = {
  addressLookupApiKeyConfigured: false,
  addressLookupProvider: "none",
  attendeeColumnOrder: "",
  bookingFee: "1.5",
  businessEmail: "ops@example.com",
  calendarFeedsEnabled: false,
  calendarFeedsGroupBy: "attendees",
  catalogGalleryEnabled: true,
  customCss: "body { color: red; }",
  embedHosts: "example.com",
  expectedTax: '{"mode":"none"}',
  externalOrderEnabled: true,
  listingColumnOrder: "",
  showPublicApi: true,
  siteFooter: "",
  taxMode: "none",
  taxRate: "",
  termsAndConditions: "Be kind.",
  theme: "light",
  underlineLinks: false,
};

const htmlFor = (name: keyof typeof SETTINGS_FORMS): string =>
  String(settingsForm(SETTINGS_FORMS[name], state));

describe("settingsForm", () => {
  test("renders a text setting from the schema", () => {
    const html = htmlFor("businessEmail");

    expectIncludesAll(html, [
      'action="/admin/settings/business-email"',
      'id="settings-business-email"',
      'name="business_email"',
      'type="email"',
      'value="ops@example.com"',
    ]);
  });

  test("renders an empty text value when the state has no value", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.businessEmail, { businessEmail: undefined }),
    );

    expectIncludesAll(html, [
      'name="business_email"',
      // The input itself must carry the empty value, not the empty csrf field.
      'type="email" value=""',
    ]);
  });

  test("keeps a number written in the state as it was written", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.bookingFee, { bookingFee: 0 }),
    );

    expectIncludesAll(html, ['name="booking_fee"', 'type="number" value="0"']);
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

    assertStringIncludes(html, 'id="settings-probe"');
  });

  test("renders schema footer copy for text settings", () => {
    const html = htmlFor("embedHosts");

    expectIncludesAll(html, [
      'name="embed_hosts"',
      "Use *.example.com to allow all subdomains",
    ]);
  });

  test("renders a textarea setting with its schema options", () => {
    const html = htmlFor("terms");

    expectIncludesAll(html, [
      'action="/admin/settings/terms"',
      'name="terms_and_conditions"',
      "data-markdown-preview",
      "Be kind.",
      "Formatting",
    ]);
  });

  test("renders trusted html description copy from the schema", () => {
    const html = htmlFor("showPublicApi");

    expectIncludesAll(html, ['href="/admin/guide#api"', "API guide"]);
  });

  test("renders a boolean setting from the schema", () => {
    const html = htmlFor("externalOrder");

    expectIncludesAll(html, [
      'action="/admin/settings/external-order"',
      'name="external_order_enabled"',
      '<input checked name="external_order_enabled" type="radio" value="true">',
    ]);
  });
});

describe("settingsForm multi-field forms", () => {
  test("renders the tax rate as decimal text and preserves the expected policy", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.tax, {
        expectedTax: '{"mode":"calculate_from_total","rateBasisPoints":725}',
        taxMode: "calculate_from_total",
        taxRate: "7.25",
      }),
    );
    expectIncludesAll(html, [
      'action="/admin/settings/tax"',
      'checked name="tax_mode" type="radio" value="calculate_from_total"',
      'inputmode="decimal"',
      'name="tax_rate"',
      'pattern="[0-9]+([.][0-9]{1,2})?"',
      'type="text" value="7.25"',
      'name="expected_tax"',
      'type="hidden"',
      "&quot;rateBasisPoints&quot;:725",
    ]);
  });
  const themeState = { theme: "dark", underlineLinks: false };

  test("checks exactly the radio matching the saved value", () => {
    const html = String(settingsForm(SETTINGS_FORMS.theme, themeState));

    expectIncludesAll(html, [
      '<fieldset class="radios">',
      '<input checked name="theme" type="radio" value="dark">',
      '<input name="theme" type="radio" value="light">',
    ]);
  });

  test("renders the checkbox with its class and hint, unchecked", () => {
    const html = String(settingsForm(SETTINGS_FORMS.theme, themeState));

    expectIncludesAll(html, [
      '<label class="checkbox">',
      '<input name="underline_links" type="checkbox" value="true">',
      "<small>Underline links everywhere, including the navigation.",
    ]);
  });

  test("checks the checkbox when the setting is on", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.theme, {
        theme: "light",
        underlineLinks: true,
      }),
    );

    assertStringIncludes(
      html,
      '<input checked name="underline_links" type="checkbox" value="true">',
    );
  });

  test("labels a labelFor select separately and selects the saved value", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.calendarFeeds, {
        calendarFeedsEnabled: true,
        calendarFeedsGroupBy: "listings",
      }),
    );

    expectIncludesAll(html, [
      '<label for="calendar_feeds_group_by">Group feed entries by</label>',
      '<select id="calendar_feeds_group_by" name="calendar_feeds_group_by">',
      '<option selected value="listings">Listings</option>',
      '<option value="attendees">Attendees</option>',
      '<input checked name="calendar_feeds_enabled" type="checkbox" value="true">',
    ]);
  });

  test("builds select options at render time and masks a stored secret", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.addressLookup, {
        addressLookupApiKeyConfigured: true,
        addressLookupProvider: "easypostcodes",
      }),
    );

    // No labelFor: the label wraps the select, and the select has no id.
    expectIncludesAll(html, [
      '<label>Provider<select name="address_lookup_provider">',
      '<option value="none">None (type addresses manually)</option>',
      '<option selected value="easypostcodes">',
    ]);
    const secret = html.match(
      /<input[^>]*name="address_lookup_api_key"[^>]*>/,
    )?.[0];
    assertStringIncludes(secret ?? "", 'type="password"');
    assertStringIncludes(secret ?? "", `value="${MASK_SENTINEL}"`);
  });

  test("leaves the secret input empty when nothing is stored", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.addressLookup, {
        addressLookupApiKeyConfigured: false,
        addressLookupProvider: "none",
      }),
    );

    assert(!html.includes(MASK_SENTINEL));
    assertStringIncludes(html, '<option selected value="none">');
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

    assertStringIncludes(html, 'name="business_email"');
    assert(!html.includes("placeholder"));
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

    expectIncludesAll(html, [
      'placeholder="Built placeholder"',
      "<p><small>Built footer note</small></p>",
    ]);
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
    assertStringIncludes(input ?? "", 'type="number"');
    assertStringIncludes(input ?? "", 'max="10"');
    assertStringIncludes(input ?? "", 'min="0"');
    assertStringIncludes(input ?? "", 'minlength="2"');
    assertStringIncludes(input ?? "", 'step="0.1"');
    assertStringIncludes(input ?? "", "required");
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
    assertStringIncludes(html, `</h2>${description}</div>`);
    assert(!html.includes(`<p>${description}</p>`));
  });

  test("shows the placeholder as the value when nothing is saved yet", () => {
    const probe = textProbe({ valueFallback: "placeholder" });
    const empty = String(settingsForm(probe, { businessEmail: "" }));
    const saved = String(settingsForm(probe, state));

    assertStringIncludes(empty, 'value="contact@example.com"');
    assertStringIncludes(saved, 'value="ops@example.com"');
  });
});
