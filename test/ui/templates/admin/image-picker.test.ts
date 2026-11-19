/**
 * The markdown editor's image picker template
 * (`src/ui/templates/admin/image-picker.tsx`): what the browser finds in it.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ImagePickerTemplate } from "#templates/admin/image-picker.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withSubmittedValues } from "#test-utils/saved-form.ts";

/** One attribute's value on a tag. Null when the tag lacks it. */
const attributeOrNull = (tag: string, name: string): string | null =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Each input's name, type, required flag, and value, in page order. */
const inputsOf = (html: string) =>
  [...html.matchAll(/<input[^>]*>/g)].map(([input]) => ({
    name: attributeOrNull(input, "name"),
    required: /\srequired[\s/>]/.test(input),
    type: attributeOrNull(input, "type"),
    value: attributeOrNull(input, "value"),
  }));

describe("the image picker template", () => {
  beforeAll(setupAdminPageTest);

  test("the upload form posts multipart to the images route", () => {
    const html = String(ImagePickerTemplate());
    const [form] = /<form[^>]*>/.exec(html) ?? [""];

    expect(form).toBe(
      '<form action="/admin/images" autocomplete="off" method="POST" ' +
        'class="md-image-upload" enctype="multipart/form-data">',
    );
  });

  test("the upload fields stay empty after a failed page save", async () => {
    // A listing form that fails validation renders again with its saved
    // values. Its name field shares the upload's field name.
    const html = await withSubmittedValues(
      { altText: "Fair poster", name: "Summer fair" },
      () => String(ImagePickerTemplate()),
    );

    const textInputs = inputsOf(html).filter(({ type }) => type === "text");
    expect(textInputs.map(({ value }) => value)).toEqual([null, null]);
  });

  test("the upload form carries the images area's fields", () => {
    const fields = inputsOf(String(ImagePickerTemplate())).map(
      ({ name, required, type }) => ({ name, required, type }),
    );

    expect(fields).toEqual([
      { name: "csrfToken", required: false, type: "hidden" },
      { name: "name", required: true, type: "text" },
      { name: "altText", required: false, type: "text" },
      { name: "image", required: false, type: "file" },
    ]);
  });

  test("the dialog carries the parts that the browser wires", () => {
    // The editor finds the close button and the grid by these classes.
    expectIncludesAll(String(ImagePickerTemplate()), [
      '<dialog class="md-image-dialog">',
      'class="md-preview-close"',
      '<div class="md-image-grid"></div>',
    ]);
  });

  test("the picker carries one note for each grid state", () => {
    const notes = [
      ...String(ImagePickerTemplate()).matchAll(
        /<p class="md-image-note" data-note="([^"]+)">([^<]*)<\/p>/g,
      ),
    ].map(([, note, copy]) => [note, copy]);

    expect(notes).toEqual([
      ["empty", "No images yet."],
      ["loading", "Loading…"],
      ["uploadFailed", "The image could not be uploaded. Please try again."],
    ]);
  });
});
