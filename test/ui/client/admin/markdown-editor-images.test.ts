/**
 * The image dropdown toolbar control
 * (`src/ui/client/admin/markdown-editor-images.ts`): the real editor mount,
 * a stubbed image-list endpoint, and the actual insert path.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import type { Window } from "happy-dom";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { cleanup, enhanced, select } from "#test-utils/markdown-editor-dom.ts";

afterEach(cleanup);
afterEach(() => fetchStub?.restore());

let fetchStub: Stub | undefined;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

/** The two-image library the list and insert cases share, already in the
 * name order the options endpoint returns. */
const twoImageList = (): Response =>
  json({
    images: [
      { id: 2, name: "Alpha" },
      { id: 9, name: "Zebra" },
    ],
  });

/** Let the stubbed fetch and the panel render settle (microtasks only). */
const untilReady = async (panel: HTMLElement): Promise<void> => {
  for (let i = 0; i < 100 && panel.dataset.state !== "ready"; i += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
};

describe("the image dropdown toolbar control", () => {
  test("renders the image button in the toolbar", () => {
    const { window, handle } = enhanced("hello");
    const button = window.document.querySelector(".md-toolbar-image");
    expect(button).toBeTruthy();
    expect(button?.getAttribute("aria-label")).toBe("Insert image");
    handle.view.destroy();
  });

  test("lists the existing images by name in name order without thumbnails", async () => {
    fetchStub = stubFetch(twoImageList());
    const { window, handle } = enhanced("hello");
    toolbarImageButton(window).click();
    const panel = dropdownPanel(window);
    await untilReady(panel);

    expect(fetchStub.calls[0]?.args[0]).toBe("/admin/images/options");
    const names = [...panel.querySelectorAll("button")].map(
      (item) => item.textContent,
    );
    expect(names).toEqual(["Alpha", "Zebra"]);
    expect(panel.querySelector("img")).toBeNull();
    handle.view.destroy();
  });

  test("inserts the short-form image tag at the caret", async () => {
    const time = new FakeTime();
    try {
      fetchStub = stubFetch(twoImageList());
      const { window, handle, textarea } = enhanced("hello ");
      select(handle.view, 7);
      toolbarImageButton(window).click();
      const panel = dropdownPanel(window);
      await untilReady(panel);

      const option = [...panel.querySelectorAll("button")].find(
        (item) => item.textContent === "Alpha",
      )!;
      option.click();

      // The CommonMark schema holds images as block nodes: the insert lands
      // on its own line after the caret's paragraph.
      expect(textarea.value).toBe("hello\n\n![Alpha](img#2)");
      handle.view.destroy();
      // Prosemirror's focus handler schedules a 20 ms selection flush; run
      // it out on the virtual clock so the file ends with no pending timer.
      await time.tickAsync(30);
    } finally {
      time.restore();
    }
  });

  test("shows a plain message when the image list cannot load", async () => {
    fetchStub = stubFetch(new Error("storage down"));
    const { window, handle } = enhanced("hello");
    toolbarImageButton(window).click();
    const panel = dropdownPanel(window);
    await untilReady(panel);

    expect(panel.dataset.state).toBe("error");
    expect(panel.textContent).toContain("Images are unavailable right now.");
    handle.view.destroy();
  });

  test("shows a plain message when no images exist", async () => {
    fetchStub = stubFetch(json({ images: [] }));
    const { window, handle } = enhanced("hello");
    toolbarImageButton(window).click();
    const panel = dropdownPanel(window);
    await untilReady(panel);

    expect(panel.textContent).toContain("No images uploaded yet.");
    handle.view.destroy();
  });

  test("closes the dropdown when clicking outside it", async () => {
    fetchStub = stubFetch(json({ images: [{ id: 2, name: "Alpha" }] }));
    const { window, handle } = enhanced("hello");
    toolbarImageButton(window).click();
    const panel = dropdownPanel(window);
    await untilReady(panel);

    window.document.body.click();
    expect(panel.hidden).toBe(true);
    handle.view.destroy();
  });
});

const toolbarImageButton = (window: Window) =>
  window.document.querySelector(
    ".md-toolbar-image",
  ) as unknown as HTMLButtonElement & { click: () => void };

const dropdownPanel = (window: Window) =>
  window.document.querySelector(
    ".md-image-dropdown",
  ) as unknown as HTMLElement & { hidden: boolean };
