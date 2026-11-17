import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  CONTENT_FIELD_LIMITS,
  contentFieldValues,
  contentSlugField,
  defineContentForms,
  seoContentInput,
} from "#routes/admin/content-form-fields.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { allEnglishMessages } from "#test-utils/i18n.ts";

await allEnglishMessages();

const forms = defineContentForms({
  createSlugFields: [contentSlugField()] as const,
  extraFields: [
    { label: "Extra", maxlength: 10, name: "extra", type: "text" },
  ] as const,
  nameLabel: "Thing name",
  publicLinkPath: (slug) => `/thing/${slug}`,
});

describe("content form fields", () => {
  test("the create form asks for name, slug, SEO meta, extras, then content", () => {
    expect(forms.createForm.fields.map((f) => f.name)).toEqual([
      "name",
      "slug",
      "metaTitle",
      "metaDescription",
      "extra",
      "content",
    ]);
  });

  test("the name field is required text capped at the declared name limit", () => {
    const name = forms.createForm.fields[0];
    expect(JSON.parse(JSON.stringify(name))).toEqual({
      label: "Thing name",
      maxlength: CONTENT_FIELD_LIMITS.name,
      name: "name",
      required: true,
      type: "text",
    });
  });

  test("the SEO Title and SEO Description fields keep their declared caps", () => {
    const byName = new Map(forms.createForm.fields.map((f) => [f.name, f]));
    expect(byName.get("metaTitle")).toMatchObject({
      maxlength: CONTENT_FIELD_LIMITS.metaTitle,
      type: "text",
    });
    expect(byName.get("metaDescription")).toMatchObject({
      maxlength: CONTENT_FIELD_LIMITS.metaDescription,
      type: "text",
    });
  });

  test("the content field is a markdown textarea with the declared content cap", () => {
    const content = forms.createForm.fields.at(-1);
    expect(content).toMatchObject({
      markdown: true,
      maxlength: CONTENT_FIELD_LIMITS.content,
      name: "content",
      type: "textarea",
    });
  });

  test("every shared limit is declared once in CONTENT_FIELD_LIMITS", () => {
    // The table is the one place a new content editor imports its limits
    // from, so each shared field's maxlength must read from it.
    // The SEO caps stay at the search-engine display limits.
    expect(CONTENT_FIELD_LIMITS.metaDescription).toBe(160);
    expect(CONTENT_FIELD_LIMITS.metaTitle).toBe(64);
    expect(CONTENT_FIELD_LIMITS.name).toBe(MAX_INPUT_LENGTH);
    // The body rides the shared textarea limit.
    expect(CONTENT_FIELD_LIMITS.content).toBe(MAX_TEXTAREA_LENGTH);
  });

  test("only the edit form's slug links to the public page", () => {
    const createSlug = forms.createForm.fields[1] as {
      publicLinkPath?: (slug: string) => string;
    };
    const editSlug = forms.editForm.fields[1] as {
      publicLinkPath?: (slug: string) => string;
    };
    expect(Object.keys(createSlug)).not.toContain("publicLinkPath");
    expect(editSlug.publicLinkPath?.("abc")).toBe("/thing/abc");
  });

  test("contentFieldValues pre-fills exactly the stored columns", () => {
    expect(
      contentFieldValues({
        content: "Body",
        metaDescription: "Desc",
        metaTitle: "Title",
        name: "Name",
        slug: "slug-1",
      }),
    ).toEqual({
      content: "Body",
      metaDescription: "Desc",
      metaTitle: "Title",
      name: "Name",
      slug: "slug-1",
    });
  });

  test("seoContentInput maps the form values to the input columns", () => {
    expect(
      seoContentInput({
        content: "Body",
        metaDescription: "Desc",
        metaTitle: "Title",
        name: "Name",
      }),
    ).toEqual({
      content: "Body",
      metaDescription: "Desc",
      metaTitle: "Title",
      name: "Name",
    });
  });
});
