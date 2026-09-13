import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import {
  createImageFromUpload,
  imageMetadataFromForm,
} from "#routes/admin/image-upload.ts";
import { FormParams } from "#shared/form-data.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { withStorageDisabled } from "#test-utils/mocks.ts";

const uploadForm = (): FormData => {
  const form = new FormData();
  form.set("name", "Disabled upload");
  form.set("alt_text", "Alt disabled upload");
  form.set(
    "image",
    new File([new Uint8Array([1, 2, 3])], "image.png", {
      type: "image/png",
    }),
  );
  return form;
};

/** The parser's input the way the routes build it: name, alt text, nothing
 *  else imageMetadataFromForm reads. */
const metadataForm = (name: string, altText: string): FormParams =>
  new FormParams({ alt_text: altText, name });

describe("admin image upload helper", () => {
  beforeAll(() => ensureMessageGroups(["images", "validation"]));

  test("rejects direct uploads when storage is disabled", async () => {
    await withStorageDisabled(async () => {
      expect(await createImageFromUpload(uploadForm())).toEqual({
        error: "File storage is not configured.",
        ok: false,
      });
    });
  });

  describe("imageMetadataFromForm", () => {
    test("rejects an over-long image name with the limit named", () => {
      // The rendered input caps length in the browser, but a crafted POST
      // skips the browser, so the parser carries the same limit.
      expect(
        imageMetadataFromForm(metadataForm("N".repeat(501), "Fine")),
      ).toEqual({
        error: "Image name must be 500 characters or fewer",
        ok: false,
      });
    });

    test("rejects an over-long alt text with the limit named", () => {
      expect(
        imageMetadataFromForm(metadataForm("Fine", "A".repeat(501))),
      ).toEqual({
        error: "Alt text must be 500 characters or fewer",
        ok: false,
      });
    });

    test("accepts a name exactly at the limit", () => {
      const atLimit = "N".repeat(MAX_INPUT_LENGTH);
      expect(imageMetadataFromForm(metadataForm(atLimit, ""))).toEqual({
        ok: true,
        value: { altText: "", name: atLimit },
      });
    });

    test("keeps the empty-name refusal message", () => {
      expect(imageMetadataFromForm(metadataForm("", "Alt"))).toEqual({
        error: "Image name is required",
        ok: false,
      });
    });
  });
});
