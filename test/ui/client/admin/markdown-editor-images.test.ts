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
afterEach(() => fetchStubHolder.stub?.restore());

/** The stub survives between the test body and the afterEach that restores
 * it; a const holder keeps the module free of a reassignable `let`. */
const fetchStubHolder: { stub: Stub | undefined } = { stub: undefined };

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

/** Mounts the editor against a stubbed options endpoint, opens the
 * dropdown, and returns its window, panel, and handle once settled. */
const openDropdown = async (
  respond: Response | Error,
): Promise<{
  window: Window;
  handle: Awaited<ReturnType<typeof enhanced>>["handle"];
  panel: HTMLElement;
}> => {
  fetchStubHolder.stub = stubFetch(respond);
  const { window, handle } = enhanced("hello");
  toolbarImageButton(window).click();
  const panel = dropdownPanel(window);
  await untilReady(panel);
  return { handle, panel, window };
};

/** Runs a few microtask hops so a stubbed fetch promise settles. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
};

/** Opens the dropdown and closes it before the stubbed fetch settles, so
 * the stale-open guards run against a panel the user already shut. */
const openAndCloseEarly = (respond: Response | Error): HTMLElement => {
  fetchStubHolder.stub = stubFetch(respond);
  const { window } = enhanced("hello");
  toolbarImageButton(window).click();
  const panel = dropdownPanel(window);
  toolbarImageButton(window).click();
  return panel;
};

/** Asserts the panel is shut by whatever path closed it: hidden again, the
 * button reading closed, and the handle released. */
const expectClosed = (
  window: Window,
  handle: Awaited<ReturnType<typeof enhanced>>["handle"],
  panel: HTMLElement,
): void => {
  expect(panel.hidden).toBe(true);
  expect(toolbarImageButton(window).getAttribute("aria-expanded")).toBe(
    "false",
  );
  handle.view.destroy();
};

describe("the image dropdown toolbar control", () => {
  test("renders the image button in the toolbar", () => {
    const { window, handle } = enhanced("hello");
    const button = window.document.querySelector(".md-toolbar-image");
    expect(button).toBeTruthy();
    expect(button?.getAttribute("aria-label")).toBe("Insert image");
    expect(button?.getAttribute("aria-haspopup")).toBe("true");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    handle.view.destroy();
  });

  test("lists the existing images by name in name order without thumbnails", async () => {
    fetchStubHolder.stub = stubFetch(twoImageList());
    const { window, handle } = enhanced("hello");
    toolbarImageButton(window).click();
    const panel = dropdownPanel(window);
    await untilReady(panel);

    expect(fetchStubHolder.stub?.calls[0]?.args[0]).toBe(
      "/admin/images/options",
    );
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
      fetchStubHolder.stub = stubFetch(twoImageList());
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
    const { handle, panel } = await openDropdown(new Error("storage down"));

    expect(panel.dataset.state).toBe("error");
    expect(panel.textContent).toContain("Images are unavailable right now.");
    handle.view.destroy();
  });

  test("shows a plain message when no images exist", async () => {
    const { handle, panel } = await openDropdown(json({ images: [] }));

    expect(panel.textContent).toContain("No images uploaded yet.");
    handle.view.destroy();
  });

  test("closes the dropdown when clicking outside it", async () => {
    const { window, handle, panel } = await openDropdown(
      json({ images: [{ id: 2, name: "Alpha" }] }),
    );

    window.document.body.click();
    expectClosed(window, handle, panel);
  });

  test("closes on Escape and returns focus to the button", async () => {
    const { window, handle, panel } = await openDropdown(
      json({ images: [{ id: 2, name: "Alpha" }] }),
    );

    window.document.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );
    expect(window.document.activeElement).toBe(toolbarImageButton(window));
    expectClosed(window, handle, panel);
  });

  test("closes again when the button is clicked while open", async () => {
    const { window, handle, panel } = await openDropdown(
      json({ images: [{ id: 2, name: "Alpha" }] }),
    );

    expect(panel.hidden).toBe(false);
    toolbarImageButton(window).click();
    expectClosed(window, handle, panel);
  });

  test("shows the unavailable state when the endpoint answers a failure", async () => {
    const { handle, panel } = await openDropdown(
      new Response("server down", { status: 500 }),
    );

    expect(panel.dataset.state).toBe("error");
    expect(panel.textContent).toContain("Images are unavailable right now.");
    handle.view.destroy();
  });

  test("stays closed when the library arrives after the user closed it", async () => {
    const panel = openAndCloseEarly(
      json({ images: [{ id: 2, name: "Alpha" }] }),
    );
    await flush();

    expect(panel.hidden).toBe(true);
    expect(panel.dataset.state).toBe("loading");
  });

  test("stays closed when the library fails after the user closed it", async () => {
    const panel = openAndCloseEarly(new Error("storage down"));
    await flush();

    expect(panel.hidden).toBe(true);
    expect(panel.dataset.state).toBe("loading");
  });

  test("refuses an options body without an images array", async () => {
    const { handle, panel } = await openDropdown(json({ ok: true }));

    expect(panel.dataset.state).toBe("error");
    expect(panel.querySelector("button")).toBeNull();
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
