import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { FormParams } from "#shared/form-data.ts";
import {
  getListingEditForm,
  getListingForm,
} from "#templates/fields/listing.ts";

describe("listing form schema", () => {
  test("parses month fields as numbers", () => {
    const result = getListingForm().validate(
      new FormParams({
        initial_site_months: "12",
        max_attendees: "10",
        max_quantity: "2",
        months_per_unit: "3",
        name: "Example",
      }),
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.values.months_per_unit).toBe(3);
      expect(result.values.initial_site_months).toBe(12);
    }
  });

  test("derives every section from field declarations", () => {
    const form = getListingEditForm();
    expect(form.sections).toEqual([
      "basics",
      "tickets",
      "daily",
      "duration",
      "customisable",
      "options",
      "advanced",
    ]);
    expect(form.fields.every((field) => field.section !== undefined)).toBe(
      true,
    );
  });

  test("renders conditional fields from schema visibility", () => {
    const visible = getListingEditForm({
      builder: true,
      logistics: true,
      storage: true,
      webhook: true,
    });
    const hidden = getListingEditForm({
      builder: false,
      logistics: false,
      storage: false,
      webhook: false,
    });

    expect(visible.section("basics")).toContain('name="attachment"');
    expect(visible.section("options")).toContain('name="uses_logistics"');
    expect(visible.section("advanced")).toContain('name="months_per_unit"');
    expect(visible.section("advanced")).toContain('name="webhook_url"');
    expect(hidden.section("basics")).not.toContain('name="attachment"');
    expect(hidden.section("options")).not.toContain('name="uses_logistics"');
    expect(hidden.section("advanced")).not.toContain('name="months_per_unit"');
    expect(hidden.section("advanced")).not.toContain('name="webhook_url"');
  });

  test("pairs customisable days with pay more so only one can hold", () => {
    // Checking either one disables the other and shows why; the save keeps
    // its refusal (`error.customisable_days_with_pay_more`) as the authority.
    const why = `data-exclusive-why="${t("error.customisable_days_with_pay_more")}"`;
    const html = getListingEditForm().section("customisable");
    expect(html).toMatch(
      /name="customisable_days"[^>]*data-exclusive-with="can_pay_more"/,
    );
    expect(html).toContain(why);

    const payMore = getListingEditForm().section("tickets");
    expect(payMore).toMatch(
      /name="can_pay_more"[^>]*data-exclusive-with="customisable_days"/,
    );
    expect(payMore).toContain(why);
  });
});
