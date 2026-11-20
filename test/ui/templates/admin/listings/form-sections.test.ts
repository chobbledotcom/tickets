import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingFormState } from "#templates/admin/listings/form-sections.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { registerListingTemplateHooks } from "./helpers.ts";

/** The form sections for a listing template, with the smallest values the
 *  renderer needs. */
const formSectionsHtml = (template: { id: string } | null): string =>
  listingFormState(OWNER_SESSION, [], [], template)
    .formSections({
      advancedOpen: false,
      customiseOpen: false,
      durationWarning: "",
      values: {},
    })
    .toString();

describe("listing form sections", () => {
  registerListingTemplateHooks();

  test("heads the pricing section with the template's words", () => {
    expect(
      [
        { id: "one-off-event" },
        { id: "physical-product" },
        { id: "hireable-item" },
        { id: "donation" },
        { id: "subscription" },
        null,
      ].map((template) => {
        const html = formSectionsHtml(template);
        const headings = [
          "Tickets &amp; Pricing",
          "Items &amp; Pricing",
          "Donations &amp; Pricing",
          "Subscriptions &amp; Pricing",
        ].filter((heading) => html.includes(`<legend>${heading}</legend>`));
        return headings;
      }),
    ).toEqual([
      ["Tickets &amp; Pricing"],
      ["Items &amp; Pricing"],
      ["Items &amp; Pricing"],
      ["Donations &amp; Pricing"],
      ["Subscriptions &amp; Pricing"],
      ["Items &amp; Pricing"],
    ]);
  });

  test("keeps the template's pricing heading out of the other sections", () => {
    const html = formSectionsHtml({ id: "donation" });
    assertStringIncludes(html, "<legend>Donations &amp; Pricing</legend>");
    expect(html.includes("<legend>Tickets &amp; Pricing</legend>")).toBe(false);
  });
});
