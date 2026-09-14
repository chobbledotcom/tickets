import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  CONTENT_FIELD_LIMITS,
  contentSlugField,
  defineContentForms,
} from "#routes/admin/content-form-fields.ts";
import { FormParams } from "#shared/form-data.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { builderForm } from "#templates/fields/builder.ts";
import { inputNamed } from "#test-utils/assertions.ts";

const content = defineContentForms({
  createSlugFields: [contentSlugField()],
  extraFields: [],
  nameLabel: "Name",
  publicLinkPath: (slug) => `/page/${slug}`,
});

const contentCaps = {
  meta_description: CONTENT_FIELD_LIMITS.meta_description,
  meta_title: CONTENT_FIELD_LIMITS.meta_title,
  name: MAX_INPUT_LENGTH,
};

describe("single-line form limits", () => {
  for (const [label, form, caps] of [
    ["Builder", builderForm, { site_name: MAX_INPUT_LENGTH }],
    ["Create content", content.createForm, contentCaps],
    ["Edit content", content.editForm, contentCaps],
  ] as const) {
    for (const [field, cap] of Object.entries(caps)) {
      test(`${label} accepts ${field} at its declared cap`, () => {
        const values = {
          name: "Name",
          slug: "page",
          [field]: "x".repeat(cap),
        };
        const result = form.validate(new FormParams(values));
        expect(result).toMatchObject({
          valid: true,
          values: { [field]: values[field] },
        });
      });

      test(`${label} rejects ${field} above its declared cap`, () => {
        const result = form.validate(
          new FormParams({
            name: "Name",
            slug: "page",
            [field]: "x".repeat(cap + 1),
          }),
        );
        expect(result).toMatchObject({ valid: false });
      });

      test(`${label} renders the declared cap for ${field}`, () => {
        expect(inputNamed(form.render(), field)).toContain(
          `maxlength="${cap}"`,
        );
      });
    }
  }
});
