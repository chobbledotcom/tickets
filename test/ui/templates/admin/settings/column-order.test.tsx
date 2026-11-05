import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import { configurableTableLayouts } from "#shared/tables/configurable.ts";
import { settingsForm } from "#templates/admin/settings/schema-form.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

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

    expectIncludesAll(html, [
      'action="/admin/settings/listing-column-order"',
      "<h2>Listing table columns</h2>",
      'name="column_order"',
      `placeholder="${definition.defaultTemplate}"`,
      `value="${definition.defaultTemplate}"`,
    ]);
    assert(!html.includes('value="{{phone}}"'));
    expectIncludesAll(html, [
      availableTags(definition.keys),
      'href="/admin/guide#column-order"',
      "Save listing columns",
    ]);
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

    expectIncludesAll(html, [
      'action="/admin/settings/attendee-column-order"',
      "<h2>Attendee table columns</h2>",
      `placeholder="${definition.defaultTemplate}"`,
      `value="${saved}"`,
    ]);
    assert(!html.includes('value="{{profit}}"'));
    expectIncludesAll(html, [
      availableTags(definition.keys),
      "A column is hidden when no attendee has data",
      "Save attendee columns",
    ]);
  });
});
