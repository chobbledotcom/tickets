import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { apiKeyForm } from "#routes/admin/api-keys-form.ts";
import {
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

describe("single-line form limits", () => {
  for (const [label, form, fields] of [
    ["API key", apiKeyForm, ["name"]],
    ["Builder", builderForm, ["site_name"]],
    [
      "Create content",
      content.createForm,
      ["name", "meta_title", "meta_description"],
    ],
    [
      "Edit content",
      content.editForm,
      ["name", "meta_title", "meta_description"],
    ],
  ] as const) {
    for (const field of fields) {
      test(`${label} accepts ${field} at the shared limit`, () => {
        const values = {
          name: "Name",
          slug: "page",
          [field]: "x".repeat(MAX_INPUT_LENGTH),
        };
        const result = form.validate(new FormParams(values));
        expect(result).toMatchObject({
          valid: true,
          values: { [field]: values[field] },
        });
      });

      test(`${label} rejects ${field} above the shared limit`, () => {
        const result = form.validate(
          new FormParams({
            name: "Name",
            slug: "page",
            [field]: "x".repeat(MAX_INPUT_LENGTH + 1),
          }),
        );
        expect(result).toMatchObject({ valid: false });
      });

      test(`${label} renders the shared limit for ${field}`, () => {
        expect(inputNamed(form.render(), field)).toContain(
          `maxlength="${MAX_INPUT_LENGTH}"`,
        );
      });
    }
  }
});
