/**
 * The rich editor's pictures
 * (`src/ui/client/admin/markdown-editor-image-view.ts`): the image library
 * that one editor reads, and the image node view that shows the picture a
 * stored address names.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import * as v from "valibot";
import { STATIC_ASSET_OUTFILES } from "#scripts/static-assets/outfiles.ts";
import {
  createImageLibrary,
  type ImageLibrary,
} from "#src/ui/client/admin/markdown-editor-image-view.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { requireElement } from "#test-utils/happy-dom.ts";
import { cleanup, enhanced } from "#test-utils/markdown-editor-dom.ts";
import {
  fetchStubHolder,
  flush,
  json,
  renderEditorImage,
  restoreHeldStub,
  twoImageList,
} from "#test-utils/markdown-image-dialog.ts";

afterEach(cleanup);
afterEach(restoreHeldStub);

/** The names in each library answer, in order. */
const namesOf = (options: { name: string }[]): string[] =>
  options.map((option) => option.name);

/** A library over the two-image list, with an empty list queued behind it.
 * It comes back with the names that its first read found. */
const readLibraryOnce = async (): Promise<{
  library: ImageLibrary;
  names: string[];
}> => {
  fetchStubHolder.stub = stubFetch(twoImageList(), json({ images: [] }));
  const library = createImageLibrary();
  return { library, names: namesOf(await library.load()) };
};

describe("the image library", () => {
  test("reads the library once and keeps the answer", async () => {
    const { library, names } = await readLibraryOnce();

    expect(names).toEqual(["Alpha", "Zebra"]);
    expect(namesOf(await library.load())).toEqual(["Alpha", "Zebra"]);
    expect(fetchStubHolder.stub?.calls.map((call) => call.args[0])).toEqual([
      "/admin/images/options",
    ]);
  });

  test("reads the library again after it forgets the answer", async () => {
    const { library, names } = await readLibraryOnce();

    expect(names).toEqual(["Alpha", "Zebra"]);
    library.forget();
    expect(await library.load()).toEqual([]);
    expect(fetchStubHolder.stub?.calls.length).toBe(2);
  });

  test("refuses an answer that reports a failure", async () => {
    fetchStubHolder.stub = stubFetch(new Response("down", { status: 500 }));

    await expect(createImageLibrary().load()).rejects.toThrow(
      "image options responded 500",
    );
  });

  test("refuses an answer without an images array", async () => {
    fetchStubHolder.stub = stubFetch(json({ ok: true }));

    await expect(createImageLibrary().load()).rejects.toThrow(v.ValiError);
  });
});

describe("the editor's pictures", () => {
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
      // The markdown schema makes pictures draggable.
      expect(image.draggable).toBe(true);
      handle.view.destroy();
    }
  });

  test("reads the library once for every picture in the editor", async () => {
    const { handle } = await renderEditorImage(
      "![Alpha](img#2)\n\n![Zebra](img#9)",
    );

    expect(fetchStubHolder.stub?.calls.length).toBe(1);
    handle.view.destroy();
  });

  test("shows the alt text when the library cannot load", async () => {
    const { image, handle } = await renderEditorImage(
      "![Alpha](img#2)",
      new Error("storage down"),
    );

    expect(image.alt).toBe("Alpha");
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
    expect(image.getAttribute("src")).toBe("/image/alpha.webp");
    handle.view.destroy();
  });

  test("keeps an inserted picture inside the editor box", async () => {
    // The compiled stylesheet is what the browser downloads. Its width rule
    // must reach the editor's image node through the real cascade.
    const stylesheet = await Deno.readTextFile(STATIC_ASSET_OUTFILES.css);
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
});
