import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { t } from "#i18n";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";
import { says } from "#test-utils/says.ts";

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

    says(html, 'action="/admin/settings/business-email"');
    says(html, 'id="settings-business-email"');
    says(html, 'name="business_email"');
    says(html, 'type="email"');
    says(html, 'value="ops@example.com"');
  });

  test("renders an empty text value when the state has no value", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.businessEmail, { businessEmail: undefined }),
    );

    says(html, 'name="business_email"');
    // The input itself must carry the empty value, not the empty csrf field.
    says(html, 'type="email" value=""');
  });

  test("keeps a number written in the state as it was written", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.bookingFee, { bookingFee: 0 }),
    );

    says(html, 'name="booking_fee"');
    says(html, 'type="number" value="0"');
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

    says(html, 'id="settings-probe"');
  });

  test("renders schema footer copy for text settings", () => {
    const html = htmlFor("embedHosts");

    says(html, 'name="embed_hosts"');
    says(html, "Use *.example.com to allow all subdomains");
  });

  test("renders a textarea setting with its schema options", () => {
    const html = htmlFor("terms");

    says(html, 'action="/admin/settings/terms"');
    says(html, 'name="terms_and_conditions"');
    says(html, "data-markdown-preview");
    says(html, "Be kind.");
    says(html, "Formatting");
  });

  test("renders trusted html description copy from the schema", () => {
    const html = htmlFor("showPublicApi");

    says(html, 'href="/admin/guide#api"');
    says(html, "API guide");
  });

  test("renders a boolean setting from the schema", () => {
    const html = htmlFor("externalOrder");

    says(html, 'action="/admin/settings/external-order"');
    says(html, 'name="external_order_enabled"');
    says(
      html,
      '<input checked name="external_order_enabled" type="radio" value="true">',
    );
  });
});

describe("settingsForm multi-field forms", () => {
  const themeState = { theme: "dark", underlineLinks: false };

  test("checks exactly the radio matching the saved value", () => {
    const html = String(settingsForm(SETTINGS_FORMS.theme, themeState));

    says(html, '<fieldset class="radios">');
    says(html, '<input checked name="theme" type="radio" value="dark">');
    says(html, '<input name="theme" type="radio" value="light">');
  });

  test("renders the checkbox with its class and hint, unchecked", () => {
    const html = String(settingsForm(SETTINGS_FORMS.theme, themeState));

    says(html, '<label class="checkbox">');
    says(html, '<input name="underline_links" type="checkbox" value="true">');
    says(html, "<small>Underline links everywhere, including the navigation.");
  });

  test("checks the checkbox when the setting is on", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.theme, {
        theme: "light",
        underlineLinks: true,
      }),
    );

    says(
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

    says(
      html,
      '<label for="calendar_feeds_group_by">Group feed entries by</label>',
    );
    says(
      html,
      '<select id="calendar_feeds_group_by" name="calendar_feeds_group_by">',
    );
    says(html, '<option selected value="listings">Listings</option>');
    says(html, '<option value="attendees">Attendees</option>');
    says(
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
    says(html, '<label>Provider<select name="address_lookup_provider">');
    says(html, '<option value="none">None (type addresses manually)</option>');
    says(html, '<option selected value="easypostcodes">');
    const secret = html.match(
      /<input[^>]*name="address_lookup_api_key"[^>]*>/,
    )?.[0];
    says(secret, 'type="password"');
    says(secret, `value="${MASK_SENTINEL}"`);
  });

  test("leaves the secret input empty when nothing is stored", () => {
    const html = String(
      settingsForm(SETTINGS_FORMS.addressLookup, {
        addressLookupApiKeyConfigured: false,
        addressLookupProvider: "none",
      }),
    );

    assert(!html.includes(MASK_SENTINEL));
    says(html, '<option selected value="none">');
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

    says(html, 'name="business_email"');
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

    says(html, 'placeholder="Built placeholder"');
    says(html, "<p><small>Built footer note</small></p>");
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
    says(input, 'type="number"');
    says(input, 'max="10"');
    says(input, 'min="0"');
    says(input, 'minlength="2"');
    says(input, 'step="0.1"');
    says(input, "required");
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
    says(html, `</h2>${description}</div>`);
    assert(!html.includes(`<p>${description}</p>`));
  });

  test("shows the placeholder as the value when nothing is saved yet", () => {
    const probe = textProbe({ valueFallback: "placeholder" });
    const empty = String(settingsForm(probe, { businessEmail: "" }));
    const saved = String(settingsForm(probe, state));

    says(empty, 'value="contact@example.com"');
    says(saved, 'value="ops@example.com"');
  });
});
