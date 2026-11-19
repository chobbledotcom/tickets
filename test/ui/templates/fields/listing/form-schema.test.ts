import { assert, assertStringIncludes } from "@std/assert";
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
        durationDays: "1",
        initialSiteMonths: "12",
        maxAttendees: "10",
        maximumDaysAfter: "90",
        maxPrice: "0",
        maxQuantity: "2",
        minimumDaysBefore: "1",
        minQuantity: "1",
        monthsPerUnit: "3",
        name: "Example",
        unitPrice: "0",
      }),
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.values.monthsPerUnit).toBe(3);
      expect(result.values.initialSiteMonths).toBe(12);
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
    const visible = getListingEditForm({ closed: new Map(), storage: true });
    const hidden = getListingEditForm({
      closed: new Map([
        ["monthsPerUnit", "builder"],
        ["usesLogistics", "logistics"],
        ["webhookUrl", "editor"],
      ]),
      storage: false,
    });

    assertStringIncludes(visible.section("basics"), 'name="attachment"');
    assertStringIncludes(visible.section("options"), 'name="usesLogistics"');
    assertStringIncludes(visible.section("advanced"), 'name="monthsPerUnit"');
    assertStringIncludes(visible.section("advanced"), 'name="webhookUrl"');
    assert(!hidden.section("basics").includes('name="attachment"'));
    assert(!hidden.section("options").includes('name="usesLogistics"'));
    assert(!hidden.section("advanced").includes('name="monthsPerUnit"'));
    assert(!hidden.section("advanced").includes('name="webhookUrl"'));
  });

  test("pairs customisable days with pay more so only one can hold", () => {
    // Checking either one disables the other and shows why; the save keeps
    // its refusal (`error.customisable_days_with_pay_more`) as the authority.
    const why = `data-exclusive-why="${t("error.customisable_days_with_pay_more")}"`;
    const html = getListingEditForm().section("customisable");
    expect(html).toMatch(
      /name="customisableDays"[^>]*data-exclusive-with="canPayMore"/,
    );
    assertStringIncludes(html, why);

    const payMore = getListingEditForm().section("tickets");
    expect(payMore).toMatch(
      /name="canPayMore"[^>]*data-exclusive-with="customisableDays"/,
    );
    assertStringIncludes(payMore, why);
  });
});
