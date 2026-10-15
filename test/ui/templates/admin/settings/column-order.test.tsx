import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import { configurableTableLayouts } from "#shared/tables/configurable.ts";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

const availableTags = (keys: readonly string[]): string =>
  `Available tags: ${keys.map((key) => `{{${key}}}`).join(", ")}`;

describe("column order settings forms", () => {
  beforeAll(setupAdminPageTest);

  test("uses the listing default template when no template is saved", () => {
    const definition = configurableTableLayouts.listing;
    const html = String(
      settingsForm(SETTINGS_FORMS.listingColumnOrder, {
        ...advancedDefaultState,
        attendeeColumnOrder: "{{phone}}",
        listingColumnOrder: "",
      }),
    );

    says(html, 'action="/admin/settings/listing-column-order"');
    says(html, "<h2>Listing table columns</h2>");
    says(html, 'name="column_order"');
    says(html, `placeholder="${definition.defaultTemplate}"`);
    says(html, `value="${definition.defaultTemplate}"`);
    assert(!html.includes('value="{{phone}}"'));
    says(html, availableTags(definition.keys));
    says(html, 'href="/admin/guide#column-order"');
    says(html, "Save listing columns");
  });

  test("shows the saved attendee template without replacing its placeholder", () => {
    const definition = configurableTableLayouts.attendee;
    const saved = "{{ticket}}, {{name}}, {{registered | date: &quot;%Y&quot;}}";
    const html = String(
      settingsForm(SETTINGS_FORMS.attendeeColumnOrder, {
        ...advancedDefaultState,
        attendeeColumnOrder:
          '{{ticket}}, {{name}}, {{registered | date: "%Y"}}',
        listingColumnOrder: "{{profit}}",
      }),
    );

    says(html, 'action="/admin/settings/attendee-column-order"');
    says(html, "<h2>Attendee table columns</h2>");
    says(html, `placeholder="${definition.defaultTemplate}"`);
    says(html, `value="${saved}"`);
    assert(!html.includes('value="{{profit}}"'));
    says(html, availableTags(definition.keys));
    says(html, "A column is hidden when no attendee has data");
    says(html, "Save attendee columns");
  });
});
