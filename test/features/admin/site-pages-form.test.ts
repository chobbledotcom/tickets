import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { allEnglishMessages } from "#test-utils/i18n.ts";

await allEnglishMessages();
const { sitePageEditForm, sitePageForm } = await import(
  "#routes/admin/site-pages-form.ts"
);

describe("site page forms", () => {
  test("a new page asks for its slug by hand, with no public link yet", () => {
    expect(sitePageForm.fields.map((f) => f.name)).toEqual([
      "name",
      "slug",
      "meta_title",
      "meta_description",
      "content",
    ]);
    const slug = sitePageForm.fields[1] as {
      publicLinkPath?: (slug: string) => string;
    };
    expect(slug.publicLinkPath).toBeUndefined();
  });

  test("the edit form's slug links to the saved page", () => {
    const slug = sitePageEditForm.fields[1] as {
      publicLinkPath?: (slug: string) => string;
    };
    expect(slug.publicLinkPath?.("about")).toBe("/page/about");
  });
});
