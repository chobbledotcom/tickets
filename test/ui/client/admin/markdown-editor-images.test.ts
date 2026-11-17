/**
 * The image picker dialog
 * (`src/ui/client/admin/markdown-editor-images.ts`): the real editor mount,
 * a stubbed image-list endpoint, and the dialog's render, close, and error
 * paths. The upload flow lives in the sibling upload suite.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { STATIC_ASSET_OUTFILES } from "#scripts/static-assets/outfiles.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import { requireElement } from "#test-utils/happy-dom.ts";
import { cleanup, enhanced, select } from "#test-utils/markdown-editor-dom.ts";
import {
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
  renderEditorImage,
  restoreHeldStub,
  tenImageList,
  toolbarImageButton,
  twoImageList,
  untilReady,
  withDialogClock,
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
    expect(button.getAttribute("aria-label")).toBe("Insert image");
    // The button opens a modal dialog, which carries its own focus and
    // Escape semantics, so the button only names what it opens.
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.hidden).toBe(false);
    handle.view.destroy();
  });

  test("hides the image button when storage is off", () => {
    const { window, handle } = enhanced("hello", {
      imageStorage: "off",
    });
    const button = requireElement<HTMLButtonElement>(
      window.document,
      ".md-toolbar-image",
    );

    // The page marker comes from the layout; the editor keeps the control
    // out of the toolbar rather than offering a picker with no storage.
    expect(button.hidden).toBe(true);
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

  test("closes from the dialog's close button", async () => {
    await expectDialogCloses(({ dialog }) =>
      dialog.querySelector<HTMLButtonElement>(".md-preview-close")!.click(),
    );
  });

  test("closes when its own backdrop is clicked", async () => {
    await expectDialogCloses(({ dialog }) => dialog.click());
  });

  test("loads the deep library's thumbnails lazily", async () => {
    const { grid, handle } = await openDialog([tenImageList()]);

    const images = [...grid.querySelectorAll("img")];
    expect(images[0]?.getAttribute("loading")).toBe("eager");
    expect(images[9]?.getAttribute("loading")).toBe("lazy");
    handle.view.destroy();
  });

  test("leaves a closed dialog alone when its library load fails", async () => {
    const { grid, handle } = await closeDialogBeforeAnswer(
      new Error("storage down"),
    );
    // The failed load must not reopen the dialog or flag an error in it.
    expect(grid.dataset.state).toBe("loading");
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
        handle.view.destroy();
        await flushSelection();
      },
    );
  });

  test("renders each stored image address through the library", async () => {
    const cases = [
      // A short-form reference shows the library picture...
      { alt: "Alpha", markdown: "![Alpha](img#2)", src: "/image/alpha.webp" },
      // ...with or without alt text...
      { alt: "", markdown: "![](img#2)", src: "/image/alpha.webp" },
      // ...and an id the library lacks shows the alt text alone. No src at
      // all: an empty src would make the browser request the page.
      { alt: "Gone", markdown: "![Gone](img#404)", src: null },
      // An ordinary address renders as written.
      { markdown: "![Direct](/image/direct.webp)", src: "/image/direct.webp" },
    ];
    for (const { markdown, src, alt } of cases) {
      const { image, handle } = await renderEditorImage(markdown);

      expect(image.getAttribute("src")).toBe(src);
      if (alt !== undefined) expect(image.alt).toBe(alt);
      handle.view.destroy();
    }
  });

  test("shows the alt text when the library cannot load", async () => {
    const { image, handle } = await renderEditorImage(
      "![Alpha](img#2)",
      new Error("storage down"),
    );

    expect(image.hasAttribute("src")).toBe(false);
    handle.view.destroy();
  });

  test("updates the picture when the reference's alt text changes", async () => {
    const { image, handle } = await renderEditorImage(
      '![Old](img#2 "Kept caption")',
    );

    expect(image.getAttribute("src")).toBe("/image/alpha.webp");
    expect(image.title).toBe("Kept caption");

    // Rename the alt text the way a document change would.
    let imagePos = -1;
    handle.view.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") {
        imagePos = pos;
        return false;
      }
      return true;
    });
    handle.view.dispatch(
      handle.view.state.tr.setNodeAttribute(imagePos, "alt", "New"),
    );
    handle.view.dispatch(
      handle.view.state.tr.setNodeAttribute(imagePos, "title", ""),
    );
    await flush();

    expect(image.alt).toBe("New");
    expect(image.hasAttribute("title")).toBe(false);
    handle.view.destroy();
  });

  test("shows a plain message when the image list cannot load", async () => {
    const opened = await openDialog([new Error("storage down")]);

    expect(opened.grid.dataset.state).toBe("error");
    expectGridMessage(opened, "Images are unavailable right now.");
  });

  test("shows a plain message when no images exist", async () => {
    const opened = await openDialog([json({ images: [] })]);

    expectGridMessage(opened, "No images uploaded yet.");
  });

  test("keeps the image control inert after the editor is destroyed", async () => {
    await withInsertFlow(async ({ dialog, window, handle }, flushSelection) => {
      // The dialog closes the way the operator closes it, then the editor
      // dies.
      dialog.close();
      handle.view.destroy();

      toolbarImageButton(window).click();

      // The destroyed editor's control does not reopen: the dialog stays
      // shut, and the option list is never fetched again.
      expect(dialog.open).toBe(false);
      expect(fetchStubHolder.stub?.calls.length).toBe(1);
      await flushSelection();
    });
  });

  test("keeps an inserted picture inside the editor box", async () => {
    // The compiled stylesheet is what the browser downloads. Its width rule
    // must reach the editor's image node through the real cascade.
    const stylesheet = await Deno.readTextFile(STATIC_ASSET_OUTFILES.css);
    restoreHeldStub();
    fetchStubHolder.stub = stubFetch(twoImageList());
    const { window, handle } = enhanced("![Alpha](img#2)", { stylesheet });
    const image = requireElement<HTMLImageElement>(
      window.document,
      ".ProseMirror img",
    );
    await flush();

    const happyWindow = window as Window & {
      getComputedStyle: (element: unknown) => CSSStyleDeclaration;
    };
    const computed = happyWindow.getComputedStyle(image);
    expect(computed.maxWidth).toBe("100%");
    // A block picture skips the inline line box that can leave a sliver.
    expect(computed.display).toBe("block");
    handle.view.destroy();
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
              id: 2,
              name: unbrokenName,
              thumb: "/image/a-thumb.webp",
              url: "/image/a.webp",
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

  test("shows the unavailable state when the endpoint answers a failure", async () => {
    const opened = await openDialog([
      new Response("server down", { status: 500 }),
      json({ images: [] }),
    ]);

    expect(opened.grid.dataset.state).toBe("error");
    expectGridMessage(opened, "Images are unavailable right now.");
  });

  test("stays closed when the library arrives after the dialog closed", async () => {
    // The library answer never arrives before the operator's close, so the
    // stub stays queued: the close button and Escape reach a still-loading
    // dialog, and the late answer must not reopen it.
    const { grid, handle } = await closeDialogBeforeAnswer(twoImageList());
    expect(grid.dataset.state).toBe("loading");
    handle.view.destroy();
  });

  test("refuses an options body without an images array", async () => {
    const { dialog, grid, handle } = await openDialog([
      json({ ok: true }),
      json({ images: [] }),
    ]);

    expect(grid.dataset.state).toBe("error");
    expect(grid.querySelector("button")).toBeNull();
    handle.view.destroy();
    dialog.remove();
  });

  test("refuses a malformed image entry", async () => {
    // Each reply trips a different half of the entry shape check: not an
    // object, no numeric id, no name, no thumb, no url.
    const replies: [FetchReply, ...FetchReply[]] = [
      json({ images: ["nope"] }),
      json({ images: [{ id: "2", name: "Alpha", thumb: "/t.webp" }] }),
      json({ images: [{ id: 2, thumb: "/t.webp" }] }),
      json({ images: [{ id: 2, name: "Alpha" }] }),
      json({
        images: [{ id: 2, name: "Alpha", thumb: "/t.webp" }],
      }),
    ];
    await withDialogClock(
      replies,
      {},
      async ({ dialog, window, handle }, flushSelection) => {
        const grid = imageGrid(window);

        // A failed load is never cached: round 0 re-reads the first reply
        // (the dialog opened once already); each later round shuts the
        // dialog and reopens it so the next reply is fetched.
        await untilReady(grid);
        for (let round = 0; round < replies.length; round += 1) {
          if (round > 0) toolbarImageButton(window).click();
          await untilReady(grid);
          expect(grid.dataset.state).toBe("error");
          assertStringIncludes(
            grid.textContent,
            "Images are unavailable right now.",
          );
          expect(grid.querySelector("button")).toBeNull();
          dialog.close();
        }
        expect(fetchStubHolder.stub?.calls.length).toBe(replies.length);
        handle.view.destroy();
        dialog.remove();
        await flushSelection();
      },
    );
  });
});
