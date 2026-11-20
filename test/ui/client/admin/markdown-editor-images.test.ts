/**
 * The image picker window
 * (`src/ui/client/admin/markdown-editor-images.ts`): the real editor mount,
 * a stubbed image-list endpoint, and the window's render, close, and error
 * paths. The image view suite holds the library and the pictures in the
 * editor. `markdown-editor-images/upload.test.ts` holds the upload flow.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { STATIC_ASSET_OUTFILES } from "#scripts/static-assets/outfiles.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { initAdminModalShell } from "#src/ui/client/admin/modal.ts";
import { fireEvent, requireElement } from "#test-utils/happy-dom.ts";
import { cleanup, enhanced, select } from "#test-utils/markdown-editor-dom.ts";
import {
  closeControl,
  closeDialogBeforeAnswer,
  expectDialogCloses,
  expectGridMessage,
  fetchStubHolder,
  flush,
  imageDialog,
  imageGrid,
  json,
  openDialog,
  optionByName,
  restoreHeldStub,
  tenImageList,
  toolbarImageButton,
  twoImageList,
  untilReady,
  withInsertFlow,
} from "#test-utils/markdown-image-dialog.ts";

afterEach(cleanup);
afterEach(restoreHeldStub);

describe("the image picker dialog", () => {
  test("renders the image button in the toolbar", () => {
    const { window, handle } = enhanced("hello");
    const button = requireElement<HTMLButtonElement>(
      window.document,
      ".md-toolbar-image",
    );
    expect(button.textContent).toBe("Image");
    expect(button.getAttribute("aria-label")).toBe("Insert image");
    // The button opens a window, which carries its own focus and Escape
    // semantics, so the button only names what it opens.
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.hidden).toBe(false);
    handle.view.destroy();
  });

  test("hides the image button when storage is off", () => {
    const { window, handle } = enhanced("hello", { imageStorage: false });
    const button = requireElement<HTMLButtonElement>(
      window.document,
      ".md-toolbar-image",
    );

    // The admin shell renders the picker template only with storage. The
    // editor keeps the control out of the toolbar without it, and builds
    // no picker.
    expect(button.hidden).toBe(true);
    expect(window.document.querySelector(".md-image-picker")).toBeNull();
    handle.view.destroy();
  });

  test("opens the server's picker in a window over the page", () => {
    const { window, handle } = enhanced("hello");
    // The window does not exist until the operator presses the button.
    expect(window.document.querySelector("dialog.admin-modal")).toBeNull();
    toolbarImageButton(window).click();
    const dialog = imageDialog(window);

    // The window carries the template's catalog copy in its title bar, the
    // shell's controls, and the images area's upload fields.
    expect(
      requireElement<HTMLElement>(dialog, ".admin-modal-title").textContent,
    ).toBe("Choose an image");
    expect(
      [...dialog.querySelectorAll(".admin-modal-controls button")].map(
        (control) => control.getAttribute("aria-label"),
      ),
    ).toEqual(["Minimise", "Close"]);
    expect(
      [...dialog.querySelectorAll("input")].map((input) => input.name),
    ).toEqual(["csrfToken", "name", "image"]);
    expect(dialog.querySelector("textarea")?.name).toBe("altText");
    // The window sits on the page, not inside the editor or the page form.
    expect(dialog.closest(".md-editor")).toBeNull();
    expect(dialog.parentElement).toBe(window.document.body);
    handle.view.destroy();
  });

  test("shows the library as thumbnails with their names", async () => {
    const { dialog, grid, handle } = await openDialog([twoImageList()]);

    expect(fetchStubHolder.stub?.calls[0]?.args[0]).toBe(
      "/admin/images/options",
    );
    expect(dialog.open).toBe(true);
    const options = [...grid.querySelectorAll("button")];
    expect(options.map((item) => item.textContent)).toEqual(["Alpha", "Zebra"]);
    const images = [...grid.querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/image/alpha-thumb.webp",
      "/image/zebra-thumb.webp",
    ]);
    // The thumbnails are decorative: the button's text carries the name.
    expect(images.map((image) => image.getAttribute("alt"))).toEqual(["", ""]);
    handle.view.destroy();
  });

  test("closes from the window's close button", async () => {
    await expectDialogCloses(({ dialog }) => closeControl(dialog).click());
  });

  test("closes on Escape", async () => {
    await expectDialogCloses(({ dialog, window }) =>
      fireEvent(
        dialog,
        new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      ),
    );
  });

  test("stays open when the page behind it is pressed", async () => {
    await withInsertFlow(async ({ dialog, window, handle }, flushSelection) => {
      initAdminModalShell();
      const { document } = window;
      const page = requireElement<HTMLElement>(document, ".md-editor");

      fireEvent(
        page,
        new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      page.click();

      // The press moved the focus to the page and closed nothing.
      expect(dialog.open).toBe(true);
      expect(dialog.isConnected).toBe(true);
      expect(dialog.classList.contains("is-dim")).toBe(true);
      expect(document.documentElement.dataset.adminModalPageDim).toBe("false");
      handle.view.destroy();
      await flushSelection();
    });
  });

  test("raises the open window when the button is pressed again", async () => {
    await withInsertFlow(async ({ dialog, window, handle }, flushSelection) => {
      requireElement<HTMLInputElement>(dialog, 'input[name="name"]').value =
        "Typed";

      toolbarImageButton(window).click();
      await flush();

      // One window, one library fetch, and the operator's typing is kept.
      expect(
        window.document.querySelectorAll("dialog.admin-modal"),
      ).toHaveLength(1);
      expect(fetchStubHolder.stub?.calls.length).toBe(1);
      expect(
        requireElement<HTMLInputElement>(dialog, 'input[name="name"]').value,
      ).toBe("Typed");
      handle.view.destroy();
      await flushSelection();
    });
  });

  test("loads the deep library's thumbnails lazily", async () => {
    const { grid, handle } = await openDialog([tenImageList()]);

    const images = [...grid.querySelectorAll("img")];
    expect(images[0]?.getAttribute("loading")).toBe("eager");
    expect(images[9]?.getAttribute("loading")).toBe("lazy");
    handle.view.destroy();
  });

  test("names the missing thumbnail when the option is absent", async () => {
    const { window, handle } = await openDialog([twoImageList()]);

    expect(() => optionByName(window, "Nope")).toThrow(
      "the dialog carries no Nope thumbnail",
    );
    handle.view.destroy();
  });

  test("inserts the short-form image tag at the caret and closes", async () => {
    await withInsertFlow(
      async ({ window, handle, textarea }, flushSelection) => {
        select(handle.view, 7);

        optionByName(window, "Alpha").click();
        await flush();

        // The CommonMark schema holds images as block nodes: the insert
        // lands on its own line after the caret's paragraph. The stored
        // markdown keeps the short form while the rich view shows the
        // library picture.
        expect(textarea.value).toBe("hello\n\n![Alpha](img#2)");
        const image = requireElement<HTMLImageElement>(
          window.document,
          ".ProseMirror img",
        );
        expect(image.getAttribute("src")).toBe("/image/alpha.webp");
        expect(image.alt).toBe("Alpha");
        expect(imageDialog(window).open).toBe(false);
        expect(window.document.activeElement).toBe(handle.view.dom);
        handle.view.destroy();
        await flushSelection();
      },
    );
  });

  test("shows a plain message when no images exist", async () => {
    const opened = await openDialog([json({ images: [] })]);

    expectGridMessage(opened, "No images yet.");
  });

  test("shows the load note and retries after the library fails", async () => {
    const { dialog, grid, handle, window } = await openDialog([
      new Response("down", { status: 500 }),
      twoImageList(),
    ]);

    expect(grid.textContent).toBe(
      "The image library could not load. Please try again.",
    );
    closeControl(dialog).click();
    toolbarImageButton(window).click();
    await untilReady(grid);

    expect(optionByName(window, "Alpha").textContent).toBe("Alpha");
    handle.view.destroy();
  });

  test("keeps the image control inert after the editor is destroyed", async () => {
    await withInsertFlow(async ({ dialog, window, handle }, flushSelection) => {
      // The window closes the way the operator closes it, then the editor
      // dies.
      closeControl(dialog).click();
      handle.view.destroy();

      toolbarImageButton(window).click();

      // The destroyed editor's control does not reopen: the dialog stays
      // shut, and the option list is never fetched again.
      expect(dialog.open).toBe(false);
      expect(fetchStubHolder.stub?.calls.length).toBe(1);
      await flushSelection();
    });
  });

  test("wraps a long unbroken image name inside its option", async () => {
    // The longest name the form accepts, with no break opportunity: the
    // cell caps its width, so the name must wrap its text.
    const unbrokenName = "a".repeat(MAX_INPUT_LENGTH);
    const stylesheet = await Deno.readTextFile(STATIC_ASSET_OUTFILES.css);
    const { window } = await openDialog(
      [
        json({
          images: [
            {
              full: "/image/a.webp",
              id: 2,
              name: unbrokenName,
              thumb: "/image/a-thumb.webp",
            },
          ],
        }),
        json({ images: [] }),
      ],
      { stylesheet },
    );

    const option =
      imageGrid(window).querySelector<HTMLElement>(".md-image-option")!;
    expect(option.textContent).toBe(unbrokenName);
    // The compiled stylesheet is what the browser downloads. Its wrap rule
    // must reach the option through the real cascade, not just exist in the
    // source.
    // happy-dom's Window type loses to the DOM lib here; the computed style
    // map is the read.
    const happyWindow = window as Window & {
      getComputedStyle: (element: unknown) => CSSStyleDeclaration;
    };
    expect(happyWindow.getComputedStyle(option).overflowWrap).toBe("anywhere");
  });

  test("stays closed when the library arrives after the dialog closed", async () => {
    // The library answer never arrives before the operator's close, so the
    // stub stays queued: the close button and Escape reach a still-loading
    // dialog, and the late answer must not reopen it.
    const { grid, handle } = await closeDialogBeforeAnswer(twoImageList());
    expect(grid.dataset.state).toBe("loading");
    handle.view.destroy();
  });
});
