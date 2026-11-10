/** Direct tests for the listing form's sections: the two checkboxes that open
 * extra fields, and the section renderer that fills every fieldset. */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { ListingFormSections } from "#templates/admin/listings/form-sections.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";

/** A section renderer that marks its fieldset, so the test reads which
 * sections the form asked for. */
const renderSection = (id: string): string => `<b data-section="${id}"></b>`;

const renderForm = (
  props: Partial<Parameters<typeof ListingFormSections>[0]> = {},
): string =>
  String(
    ListingFormSections({
      advancedOpen: false,
      customiseOpen: false,
      durationWarning: "",
      groups: [],
      isTemplated: false,
      renderSection,
      selectedGroupIds: [],
      values: {},
      ...props,
    }),
  );

/** The markup of one ticked box: its input, then the label and its hint, which
 * stand one space apart. */
const boxFragments = ({
  hintKey,
  id,
  labelKey,
  name,
}: {
  hintKey: string;
  id: string;
  labelKey: string;
  name: string;
}): string[] => [
  `<input checked id="${id}" name="${name}" type="checkbox" value="1">`,
  `${t(labelKey)} <small>${t(hintKey)}</small>`,
];

describe("ListingFormSections", () => {
  test("renders every section through the section renderer", () => {
    const html = renderForm();

    expectIncludesAll(html, [
      '<b data-section="basics"></b>',
      '<b data-section="tickets"></b>',
      '<b data-section="daily"></b>',
      '<b data-section="duration"></b>',
      '<b data-section="customisable"></b>',
      '<b data-section="advanced"></b>',
    ]);
    assertStringIncludes(html, t("listings_table.advanced_settings"));
  });

  test("shows each box with its label, hint, and stored choice", () => {
    const templated = renderForm({ customiseOpen: true, isTemplated: true });
    expectIncludesAll(
      templated,
      boxFragments({
        hintKey: "listings_table.customise_hint",
        id: "customise-listing",
        labelKey: "listings_table.customise",
        name: "customise",
      }),
    );

    const defaults = renderForm({
      showUseDefaults: true,
      useDefaultsChecked: true,
    });
    expectIncludesAll(
      defaults,
      boxFragments({
        hintKey: "listing_defaults.use_defaults_hint",
        id: "use-defaults",
        labelKey: "listing_defaults.use_defaults_toggle",
        name: "use_defaults",
      }),
    );
  });

  test("leaves each box unticked until its flag says otherwise", () => {
    const html = renderForm({ isTemplated: true, showUseDefaults: true });

    expect(html).toMatch(
      /<input id="customise-listing" name="customise" type="checkbox" value="1">/,
    );
    expect(html).toMatch(
      /<input id="use-defaults" name="use_defaults" type="checkbox" value="1">/,
    );
  });

  test("draws no toggle fieldset when neither box applies", () => {
    assert(!renderForm().includes('class="checkboxes"'));
    assert(
      renderForm({ isTemplated: true }).includes(
        '<fieldset class="checkboxes">',
      ),
    );
    assert(!renderForm({ isTemplated: false }).includes("customise-listing"));
  });

  test("opens each group of fields from the flags it was given", () => {
    const open = renderForm({ advancedOpen: true, durationWarning: "Warn" });

    expect(open).toMatch(/<details[^>]*class="listing-advanced"[^>]* open/);
    assertStringIncludes(open, "Warn");
    expect(renderForm().includes("Warn")).toBe(false);
  });
});
