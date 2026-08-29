import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_WEBSITE_TITLE_LENGTH } from "#db/settings/constants.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  siteContactForm,
  siteHomeForm,
  siteOrderForm,
} from "#templates/fields/site.ts";

/** The box names each site form offers, in order. */
const fieldNames = (form: { fields: ReadonlyArray<{ name: string }> }) =>
  form.fields.map((field) => field.name);

describe("site editor forms", () => {
  test("the home form offers the title box and the homepage text box", () => {
    expect(fieldNames(siteHomeForm)).toEqual([
      "website_title",
      "homepage_text",
    ]);
    const title = siteHomeForm.fields[0]!;
    expect(title.maxlength).toBe(MAX_WEBSITE_TITLE_LENGTH);
    const html = siteHomeForm.render();
    expect(html).toContain("Website title");
    // The id ties the label to the box, and the browser must not offer
    // saved site-login values for a page title.
    expect(html).toContain('id="website_title"');
    expect(html).toContain('autocomplete="off"');
  });

  test("the contact and order forms each offer their one markdown text box", () => {
    expect(fieldNames(siteContactForm)).toEqual(["contact_page_text"]);
    expect(fieldNames(siteOrderForm)).toEqual(["order_intro_text"]);
    for (const form of [siteContactForm, siteOrderForm]) {
      expect(form.fields[0]!.maxlength).toBe(MAX_TEXTAREA_LENGTH);
      // Markdown boxes carry the live preview control plain text areas lack.
      expect(form.render()).toContain("data-markdown-preview");
    }
  });
});
