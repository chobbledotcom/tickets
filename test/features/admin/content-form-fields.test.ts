import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  contentFieldValues,
  contentSlugField,
  defineContentForms,
  seoContentInput,
} from "#routes/admin/content-form-fields.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
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
      "meta_title",
      "meta_description",
      "extra",
      "content",
    ]);
  });

  test("the name field is required text capped at 128 characters", () => {
    const name = forms.createForm.fields[0];
    expect(JSON.parse(JSON.stringify(name))).toEqual({
      label: "Thing name",
      maxlength: 128,
      name: "name",
      required: true,
      type: "text",
    });
  });

  test("the SEO meta pair keeps its 64 and 160 character caps", () => {
    const byName = new Map(forms.createForm.fields.map((f) => [f.name, f]));
    expect(byName.get("meta_title")).toMatchObject({
      maxlength: 64,
      type: "text",
    });
    expect(byName.get("meta_description")).toMatchObject({
      maxlength: 160,
      type: "text",
    });
  });

  test("the content field is a markdown textarea with the shared cap", () => {
    const content = forms.createForm.fields.at(-1);
    expect(content).toMatchObject({
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "content",
      type: "textarea",
    });
  });

  test("only the edit form's slug links to the public page", () => {
    const createSlug = forms.createForm.fields[1] as {
      publicLinkPath?: (slug: string) => string;
    };
    const editSlug = forms.editForm.fields[1] as {
      publicLinkPath?: (slug: string) => string;
    };
    expect(createSlug.publicLinkPath).toBeUndefined();
    expect(editSlug.publicLinkPath?.("abc")).toBe("/thing/abc");
  });

  test("contentFieldValues pre-fills exactly the stored columns", () => {
    expect(
      contentFieldValues({
        content: "Body",
        meta_description: "Desc",
        meta_title: "Title",
        name: "Name",
        slug: "slug-1",
      }),
    ).toEqual({
      content: "Body",
      meta_description: "Desc",
      meta_title: "Title",
      name: "Name",
      slug: "slug-1",
    });
  });

  test("seoContentInput maps snake-case values to the input columns", () => {
    expect(
      seoContentInput({
        content: "Body",
        meta_description: "Desc",
        meta_title: "Title",
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
