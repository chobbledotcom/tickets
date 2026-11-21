import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import {
  createImageFromUpload,
  imageMetadataFromForm,
  withUploadedImage,
} from "#routes/admin/image-upload.ts";
import { FormParams } from "#shared/form-data.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import { withStorageDisabled } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

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
  new FormParams({ altText, name });

/** Assert that `form` is refused because file storage is switched off. */
const expectStorageNotConfigured = (form: FormData): Promise<void> =>
  withStorageDisabled(async () => {
    expect(await createImageFromUpload(form)).toEqual({
      error: "File storage is not configured.",
      ok: false,
    });
  });

describe("admin image upload helper", () => {
  beforeAll(() => ensureMessageGroups(["images", "validation"]));

  test("rejects direct uploads when storage is disabled", () =>
    expectStorageNotConfigured(uploadForm()));

  test("reads a one-byte file as a file, not as a missing one", async () => {
    const form = new FormData();
    form.set("name", "Tiny upload");
    form.set(
      "image",
      new File([new Uint8Array([1])], "tiny.png", { type: "image/png" }),
    );
    await expectStorageNotConfigured(form);
  });

  test("asks for a file when the form sends none, or an empty one", async () => {
    const missing = new FormData();
    missing.set("name", "Missing upload");
    const empty = new FormData();
    empty.set("name", "Empty upload");
    empty.set("image", new File([], "empty.png", { type: "image/png" }));
    for (const form of [missing, empty]) {
      expect(await createImageFromUpload(form)).toEqual({
        error: "Choose an image file to upload",
        ok: false,
      });
    }
  });

  test("sends a failed upload back to its form with an error flash", async () => {
    const form = new FormData();
    form.set("name", "Missing upload");

    const response = await withRequestContext(() =>
      withUploadedImage(form, "/admin/images/new", () =>
        Promise.resolve(new Response("saved")),
      ),
    );

    expectRedirect(response, "/admin/images/new");
    expectFlash(response, "Choose an image file to upload", false);
  });

  describe("imageMetadataFromForm", () => {
    test("rejects an over-long image name with the limit named", () => {
      // The rendered input caps length in the browser, but a crafted POST
      // skips the browser, so the parser carries the same limit.
      expect(
        imageMetadataFromForm(metadataForm("N".repeat(251), "Fine")),
      ).toEqual({
        error: "Image name must be 250 characters or fewer",
        ok: false,
      });
    });

    test("rejects an over-long alt text with the limit named", () => {
      expect(
        imageMetadataFromForm(metadataForm("Fine", "A".repeat(251))),
      ).toEqual({
        error: "Alt text must be 250 characters or fewer",
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
