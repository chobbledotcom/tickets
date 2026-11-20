/**
 * The image picker dialog's upload flow
 * (`src/ui/client/admin/markdown-editor-images.ts`): the inline form, the
 * multipart POST to the images route, and the insert that follows a
 * successful upload.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { requireElement } from "#test-utils/happy-dom.ts";
import { cleanup, PICKER_CSRF_TOKEN } from "#test-utils/markdown-editor-dom.ts";
import {
  expectGridMessage,
  fetchStubHolder,
  finishUpload,
  flush,
  json,
  openDialog,
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
  test("uploads the chosen file's bytes with the image's name", async () => {
    await withUploadFlow(
      async ({ dialog, handle, textarea }, flushSelection) => {
        await submitUpload(dialog, "Harbour", {
          bytes: [1, 2, 3],
          name: "harbour-haze.png",
          type: "image/png",
        });

        const body = fetchStubHolder.stub?.calls[1]?.args[1]?.body;
        expect(body).toBeInstanceOf(FormData);
        const image = (body as FormData).get("image");
        expect(image).toBeInstanceOf(File);
        expect((image as File).name).toBe("harbour-haze.png");
        expect((image as File).type).toBe("image/png");

        // The uploaded image's name becomes the reference's alt text.
        await finishUpload(handle, textarea, dialog, flushSelection);
      },
    );
  });

  test("keeps the upload's submit away from the page form", async () => {
    await withUploadFlow(
      async ({ dialog, handle, textarea, window }, flushSelection) => {
        // The dialog sits inside the page form, so an unstopped submit
        // bubbles up and the page form sees it too.
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

  test("treats a redirect without an image id as a failed upload", async () => {
    const { dialog, handle } = await openDialog([
      twoImageList(),
      redirected("/admin/pages/1/edit"),
    ]);

    await submitUpload(dialog, "Harbour");

    expect(dialog.open).toBe(true);
    assertStringIncludes(
      dialog.textContent,
      "The image could not be uploaded. Please try again.",
    );
    expect(
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
    ).toBe(false);
    handle.view.destroy();
    dialog.remove();
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

  test("keeps the dialog open while an upload is in flight", async () => {
    const { promise: upload, resolve: resolveUpload } =
      Promise.withResolvers<Response>();
    await withDialogClock(
      [twoImageList(), () => upload],
      { form: true, value: "" },
      async ({ dialog, handle, textarea }, flushSelection) => {
        await submitUpload(dialog, "Harbour");

        requireElement<HTMLButtonElement>(dialog, ".md-preview-close").click();
        expect(dialog.open).toBe(true);
        dialog.click();
        expect(dialog.open).toBe(true);
        const cancel = new Event("cancel", { cancelable: true });
        dialog.dispatchEvent(cancel);
        expect(cancel.defaultPrevented).toBe(true);
        expect(dialog.open).toBe(true);

        resolveUpload(redirected("/admin/images/12/edit"));
        await flush();

        expect(dialog.open).toBe(false);
        expect(textarea.value).toContain("img#12");
        handle.view.destroy();
        await flushSelection();
      },
    );
  });

  test("keeps the dialog open with a plain message when the upload fails", async () => {
    // The first reply is the options list; the upload itself fails.
    const opened = await openDialog([
      twoImageList(),
      new Response("storage down", { status: 500 }),
      new Response("storage down", { status: 500 }),
    ]);
    const { dialog } = opened;

    await submitUpload(dialog, "Harbour");

    expect(dialog.open).toBe(true);
    // The submit re-enables, so the operator can retry without closing.
    expect(
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
    ).toBe(false);
    expectGridMessage(
      opened,
      "The image could not be uploaded. Please try again.",
    );
  });
});
