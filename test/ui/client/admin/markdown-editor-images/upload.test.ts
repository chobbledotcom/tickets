/**
 * The image picker window's upload flow
 * (`src/ui/client/admin/markdown-editor-images.ts`): the inline form, the
 * multipart POST to the images route, and the insert that follows a
 * successful upload. The picker template's own tests cover the shared upload
 * failures, the file bytes, and the window that stays open during an upload.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { requireElement } from "#test-utils/happy-dom.ts";
import { cleanup, PICKER_CSRF_TOKEN } from "#test-utils/markdown-editor-dom.ts";
import {
  fetchStubHolder,
  finishUpload,
  flush,
  json,
  redirected,
  restoreHeldStub,
  submitUpload,
  twoImageList,
  withDialogClock,
  withUploadFlow,
} from "#test-utils/markdown-image-dialog.ts";

afterEach(cleanup);
afterEach(restoreHeldStub);

describe("the image picker dialog", () => {
  test("keeps the upload's submit away from the page form", async () => {
    await withUploadFlow(
      async ({ dialog, handle, textarea, window }, flushSelection) => {
        // The window sits on the page, outside the page form, so the page
        // form never sees the picker's submit.
        const pageForm = requireElement<HTMLFormElement>(
          window.document,
          'form[action="/admin/pages/1/edit"]',
        );
        const pageSubmits: Event[] = [];
        pageForm.addEventListener("submit", (event) => pageSubmits.push(event));
        // The browser's own POST navigates away from the unsaved page.
        const nativeSubmitsStopped: boolean[] = [];
        requireElement(dialog, ".md-image-upload").addEventListener(
          "submit",
          (event) => nativeSubmitsStopped.push(event.defaultPrevented),
        );

        await submitUpload(dialog, "Harbour");

        expect(pageSubmits).toEqual([]);
        expect(nativeSubmitsStopped).toEqual([true]);
        await finishUpload(handle, textarea, dialog, flushSelection);
      },
    );
  });

  test("shows the uploaded picture in the editor", async () => {
    // The upload changed the library, so the inserted picture's lookup reads
    // it again and finds the new image.
    const harbour = {
      full: "/image/harbour.webp",
      id: 12,
      name: "Harbour",
      thumb: "/image/harbour-thumb.webp",
    };
    await withDialogClock(
      [
        twoImageList(),
        redirected("/admin/images/12/edit"),
        json({ images: [harbour] }),
      ],
      { form: true, value: "" },
      async ({ dialog, handle, textarea, window }, flushSelection) => {
        await submitUpload(dialog, "Harbour");
        await flush();

        const image = requireElement<HTMLImageElement>(
          window.document,
          ".ProseMirror img",
        );
        expect(image.getAttribute("src")).toBe("/image/harbour.webp");
        await finishUpload(handle, textarea, dialog, flushSelection);
      },
    );
  });

  test("inserts the image when its edit page fails after the upload", async () => {
    // The redirect to the edit page proves the image exists. A retry after a
    // false failure note would store it twice.
    await withDialogClock(
      [twoImageList(), redirected("/admin/images/12/edit", 500)],
      { form: true, value: "" },
      async ({ dialog, handle, textarea }, flushSelection) => {
        await submitUpload(dialog, "Harbour");

        expect(textarea.value).toBe("![Harbour](img#12)");
        await finishUpload(handle, textarea, dialog, flushSelection);
      },
    );
  });

  test("ignores a second submit press while an upload is in flight", async () => {
    await withUploadFlow(
      async ({ dialog, handle, textarea }, flushSelection) => {
        const form = dialog.querySelector<HTMLFormElement>(".md-image-upload")!;
        form.querySelector<HTMLInputElement>('input[name="name"]')!.value =
          "Harbour";
        const submit = form.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        )!;

        submit.click();
        // A disabled button swallows its own clicks, so the duplicate press
        // arrives the other way a submit can: the Enter key dispatches the
        // submit event on the form directly.
        form.dispatchEvent(new Event("submit", { cancelable: true }));
        await flush();

        // The second press hit the disabled guard: exactly one upload ran.
        // (The preview's own library refetch may follow; it is not a POST.)
        const uploads = (fetchStubHolder.stub?.calls ?? []).filter(
          (call) => call.args[1]?.method === "POST",
        );
        expect(uploads.length).toBe(1);
        await finishUpload(handle, textarea, dialog, flushSelection);
      },
    );
  });

  test("uploads through the images route and inserts the new image", async () => {
    await withUploadFlow(
      async ({ dialog, handle, textarea }, flushSelection) => {
        await submitUpload(dialog, "Harbour");

        // The upload posted to the images route as a multipart form carrying
        // the picker form's own fields and CSRF token, not the page form's.
        const uploadCall = fetchStubHolder.stub?.calls[1];
        expect(new URL(String(uploadCall?.args[0])).pathname).toBe(
          "/admin/images",
        );
        expect(uploadCall?.args[1]?.method).toBe("POST");
        const body = uploadCall?.args[1]?.body;
        expect(body).toBeInstanceOf(FormData);
        expect([...(body as FormData).entries()]).toEqual([
          ["csrfToken", PICKER_CSRF_TOKEN],
          ["name", "Harbour"],
          ["altText", ""],
        ]);

        await finishUpload(handle, textarea, dialog, flushSelection);

        // The next open offers a clean form, ready for another upload.
        const form = dialog.querySelector<HTMLFormElement>(".md-image-upload")!;
        expect(
          form.querySelector<HTMLInputElement>('input[name="name"]')!.value,
        ).toBe("");
        expect(
          form.querySelector<HTMLButtonElement>('button[type="submit"]')!
            .disabled,
        ).toBe(false);
      },
    );
  });
});
