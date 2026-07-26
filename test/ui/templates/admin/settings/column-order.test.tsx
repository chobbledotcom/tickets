import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { configurableTableLayouts } from "#shared/tables/configurable.ts";
import {
  AttendeeColumnOrderForm,
  ListingColumnOrderForm,
} from "#templates/admin/settings/column-order.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

const availableTags = (keys: readonly string[]): string =>
  `Available tags: ${keys.map((key) => `{{${key}}}`).join(", ")}`;

describe("column order settings forms", () => {
  beforeAll(setupAdminPageTest);

  test("uses the listing default template when no template is saved", () => {
    const definition = configurableTableLayouts.listing;
    const html = String(
      ListingColumnOrderForm({
        ...advancedDefaultState,
        attendeeColumnOrder: "{{phone}}",
        listingColumnOrder: "",
      }),
    );

    expect(html).toContain('action="/admin/settings/listing-column-order"');
    expect(html).toContain("<h2>Listing table columns</h2>");
    expect(html).toContain('name="column_order"');
    expect(html).toContain(`placeholder="${definition.defaultTemplate}"`);
    expect(html).toContain(`value="${definition.defaultTemplate}"`);
    expect(html).not.toContain('value="{{phone}}"');
    expect(html).toContain(availableTags(definition.keys));
    expect(html).toContain('href="/admin/guide#column-order"');
    expect(html).toContain("Save listing columns");
  });

  test("shows the saved attendee template without replacing its placeholder", () => {
    const definition = configurableTableLayouts.attendee;
    const saved = "{{ticket}}, {{name}}, {{registered | date: &quot;%Y&quot;}}";
    const html = String(
      AttendeeColumnOrderForm({
        ...advancedDefaultState,
        attendeeColumnOrder:
          '{{ticket}}, {{name}}, {{registered | date: "%Y"}}',
        listingColumnOrder: "{{profit}}",
      }),
    );

    expect(html).toContain('action="/admin/settings/attendee-column-order"');
    expect(html).toContain("<h2>Attendee table columns</h2>");
    expect(html).toContain(`placeholder="${definition.defaultTemplate}"`);
    expect(html).toContain(`value="${saved}"`);
    expect(html).not.toContain('value="{{profit}}"');
    expect(html).toContain(availableTags(definition.keys));
    expect(html).toContain("A column is hidden when no attendee has data");
    expect(html).toContain("Save attendee columns");
  });
});
