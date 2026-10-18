import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { t } from "#i18n";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";

const state = {
  addressLookupApiKeyConfigured: false,
  addressLookupProvider: "none",
  attendeeColumnOrder: "",
  bookingFee: "1.5",
  businessEmail: "ops@example.com",
  calendarFeedsEnabled: false,
  calendarFeedsGroupBy: "attendees",
  customCss: "body { color: red; }",
  embedHosts: "example.com",
  externalOrderEnabled: true,
  listingColumnOrder: "",
  showPublicApi: true,
  siteFooter: "",
  termsAndConditions: "Be kind.",
  theme: "light",
  underlineLinks: false,
};

const htmlFor = (name: keyof typeof SETTINGS_FORMS): string =>
  String(settingsForm(SETTINGS_FORMS[name], state));

describe("settingsForm", () => {
  test("renders a text setting from the schema", () => {
    const html = htmlFor("businessEmail");

    assertStringIncludes(html, 'action="/admin/settings/business-email"');
    assertStringIncludes(html, 'id="settings-business-email"');
    assertStringIncludes(html, 'name="business_email"');
    assertStringIncludes(html, 'type="email"');
    assertStringIncludes(html, 'value="ops@example.com"');
  });

  test("renders an empty text value when the state has no value", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.businessEmail, { businessEmail: undefined }),
    );

    assertStringIncludes(html, 'name="business_email"');
    // The input itself must carry the empty value, not the empty csrf field.
    assertStringIncludes(html, 'type="email" value=""');
  });

  test("keeps a number written in the state as it was written", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.bookingFee, { bookingFee: 0 }),
    );

    assertStringIncludes(html, 'name="booking_fee"');
    assertStringIncludes(html, 'type="number" value="0"');
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

    assertStringIncludes(html, 'name="embed_hosts"');
    assertStringIncludes(html, "Use *.example.com to allow all subdomains");
  });

  test("renders a textarea setting with its schema options", () => {
    const html = htmlFor("terms");

    assertStringIncludes(html, 'action="/admin/settings/terms"');
    assertStringIncludes(html, 'name="terms_and_conditions"');
    assertStringIncludes(html, "data-markdown-preview");
    assertStringIncludes(html, "Be kind.");
    assertStringIncludes(html, "Formatting");
  });

  test("renders trusted html description copy from the schema", () => {
    const html = htmlFor("showPublicApi");

    assertStringIncludes(html, 'href="/admin/guide#api"');
    assertStringIncludes(html, "API guide");
  });

  test("renders a boolean setting from the schema", () => {
    const html = htmlFor("externalOrder");

    assertStringIncludes(html, 'action="/admin/settings/external-order"');
    assertStringIncludes(html, 'name="external_order_enabled"');
    assertStringIncludes(
      html,
      '<input checked name="external_order_enabled" type="radio" value="true">',
    );
  });
});

describe("settingsForm multi-field forms", () => {
  const themeState = { theme: "dark", underlineLinks: false };

  test("checks exactly the radio matching the saved value", () => {
    const html = String(settingsForm(SETTINGS_FORMS.theme, themeState));

    assertStringIncludes(html, '<fieldset class="radios">');
    assertStringIncludes(
      html,
      '<input checked name="theme" type="radio" value="dark">',
    );
    assertStringIncludes(
      html,
      '<input name="theme" type="radio" value="light">',
    );
  });

  test("renders the checkbox with its class and hint, unchecked", () => {
    const html = String(settingsForm(SETTINGS_FORMS.theme, themeState));

    assertStringIncludes(html, '<label class="checkbox">');
    assertStringIncludes(
      html,
      '<input name="underline_links" type="checkbox" value="true">',
    );
    assertStringIncludes(
      html,
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

    assertStringIncludes(
      html,
      '<label for="calendar_feeds_group_by">Group feed entries by</label>',
    );
    assertStringIncludes(
      html,
      '<select id="calendar_feeds_group_by" name="calendar_feeds_group_by">',
    );
    assertStringIncludes(
      html,
      '<option selected value="listings">Listings</option>',
    );
    assertStringIncludes(html, '<option value="attendees">Attendees</option>');
    assertStringIncludes(
      html,
      '<input checked name="calendar_feeds_enabled" type="checkbox" value="true">',
    );
  });

  test("builds select options at render time and masks a stored secret", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.addressLookup, {
        addressLookupApiKeyConfigured: true,
        addressLookupProvider: "easypostcodes",
      }),
    );

    // No labelFor: the label wraps the select, and the select has no id.
    assertStringIncludes(
      html,
      '<label>Provider<select name="address_lookup_provider">',
    );
    assertStringIncludes(
      html,
      '<option value="none">None (type addresses manually)</option>',
    );
    assertStringIncludes(html, '<option selected value="easypostcodes">');
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

    assertStringIncludes(html, 'placeholder="Built placeholder"');
    assertStringIncludes(html, "<p><small>Built footer note</small></p>");
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
