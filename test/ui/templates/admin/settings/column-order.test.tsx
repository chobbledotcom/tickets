import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import { configurableTableLayouts } from "#shared/tables/configurable.ts";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

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

    assertStringIncludes(html, 'action="/admin/settings/listing-column-order"');
    assertStringIncludes(html, "<h2>Listing table columns</h2>");
    assertStringIncludes(html, 'name="column_order"');
    assertStringIncludes(html, `placeholder="${definition.defaultTemplate}"`);
    assertStringIncludes(html, `value="${definition.defaultTemplate}"`);
    assert(!html.includes('value="{{phone}}"'));
    assertStringIncludes(html, availableTags(definition.keys));
    assertStringIncludes(html, 'href="/admin/guide#column-order"');
    assertStringIncludes(html, "Save listing columns");
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

    assertStringIncludes(
      html,
      'action="/admin/settings/attendee-column-order"',
    );
    assertStringIncludes(html, "<h2>Attendee table columns</h2>");
    assertStringIncludes(html, `placeholder="${definition.defaultTemplate}"`);
    assertStringIncludes(html, `value="${saved}"`);
    assert(!html.includes('value="{{profit}}"'));
    assertStringIncludes(html, availableTags(definition.keys));
    assertStringIncludes(html, "A column is hidden when no attendee has data");
    assertStringIncludes(html, "Save attendee columns");
  });
});
