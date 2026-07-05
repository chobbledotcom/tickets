import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createImageFromUpload } from "#routes/admin/image-upload.ts";
import { withStorageDisabled } from "#test-utils";

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

describe("admin image upload helper", () => {
  test("rejects direct uploads when storage is disabled", async () => {
    await withStorageDisabled(async () => {
      expect(await createImageFromUpload(uploadForm())).toEqual({
        error: "File storage is not configured.",
        ok: false,
      });
    });
  });
});
