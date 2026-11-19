/**
 * The shared admin modal shell (`src/ui/client/admin/modal.ts`): the window
 * the admin pages open, its controls, its stack, its drag, and its leave
 * warning. The pointer and focus behaviour also runs against a real Chromium
 * in `admin-modal-browser.contract.ts`; this file pins the rules the DOM can
 * show without a browser layout.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import * as v from "valibot";
import { modalSettingsSchema } from "#shared/admin-modal.ts";
import { ICONS_PATH } from "#shared/asset-paths.ts";
import {
  initAdminModalShell,
  openAdminModal,
} from "#src/ui/client/admin/modal.ts";
import { AdminModalTemplate } from "#templates/admin/modal.tsx";
import {
  closeDialogs,
  createDomInstaller,
  fireEvent,
  requireElement,
  requireElements,
} from "#test-utils/happy-dom.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

/** The shell's markup as the server renders it, with the catalog's words. */
const TEMPLATE = await withRequestContext(() => String(AdminModalTemplate()));

const { installDom, cleanup } = createDomInstaller(["Element"]);

const SETTINGS = {
  collapsedTitle: "First, small",
  key: "first",
  title: "First",
};

const OTHER_SETTINGS = {
  collapsedTitle: "Second, small",
  key: "second",
  title: "Second",
};

/** One open modal and the page it sits on. */
type Open = { dialog: HTMLDialogElement; window: Window };

/** The drag protocol the shell answers, with the pointer capture recorded. */
type DragPage = Open & {
  bar: HTMLElement;
  capture: { captured: number[]; released: number[] };
  start: { left: number; top: number };
};

/** Mount a page with the shell's template, and start the shell on it. */
const page = (html = TEMPLATE): Window => {
  const window = installDom(html);
  initAdminModalShell();
  return window;
};

const dialogsIn = (window: Window): HTMLDialogElement[] =>
  requireElements<HTMLDialogElement>(window.document, "dialog.admin-modal");

/** Open a modal and hand back the window it opened or raised. The open list
 *  puts a raised modal last, so the last dialog is that one. */
const open = (
  window: Window,
  settings: unknown = SETTINGS,
): HTMLDialogElement => {
  openAdminModal(settings, document.createElement("div"));
  const dialogs = dialogsIn(window);
  return dialogs[dialogs.length - 1]!;
};

const oneWindow = (): Open => {
  const window = page();
  return { dialog: open(window), window };
};

/** Where the shell put the modal, read back from the two custom properties. */
const placed = (dialog: HTMLElement): { left: number; top: number } => ({
  left: Number.parseFloat(dialog.style.getPropertyValue("--admin-modal-left")),
  top: Number.parseFloat(dialog.style.getPropertyValue("--admin-modal-top")),
});

/** The z-index of every open window, in open order. */
const stackOf = (window: Window): number[] =>
  dialogsIn(window).map((dialog) => Number(dialog.style.zIndex));

/** Give the shell a size to clamp against. A DOM without a layout answers
 *  every rectangle with zeroes. */
const setSize = (window: Window, width: number, height: number): void => {
  for (const dialog of dialogsIn(window)) {
    Object.defineProperty(dialog, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: height,
        height,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
      }),
    });
  }
};

/** A pointer event the shell reads. The element's own dispatch takes it as
 *  it is, so the type stays open. */
const pointer = (
  window: Window,
  type: string,
  x: number,
  y: number,
  options: { button?: number; pointerId?: number } = {},
): unknown =>
  new window.PointerEvent(type, {
    bubbles: true,
    button: options.button ?? 0,
    clientX: x,
    clientY: y,
    pointerId: options.pointerId ?? 7,
  });

/** Record the pointer capture calls, which the DOM keeps for a browser. */
const captureOn = (
  bar: HTMLElement,
): { captured: number[]; released: number[] } => {
  const captured: number[] = [];
  const released: number[] = [];
  Object.defineProperty(bar, "setPointerCapture", {
    value: (id: number) => captured.push(id),
  });
  Object.defineProperty(bar, "releasePointerCapture", {
    value: (id: number) => released.push(id),
  });
  return { captured, released };
};

/** A page with one modal, a size to clamp against, and the drag wired. */
const dragPage = (width = 300, height = 200): DragPage => {
  const window = page();
  const dialog = open(window);
  setSize(window, width, height);
  const bar = requireElement<HTMLElement>(dialog, ".admin-modal-bar");
  return {
    bar,
    capture: captureOn(bar),
    dialog,
    start: placed(dialog),
    window,
  };
};

const pressTitleBar = ({ bar, start, window }: DragPage): void => {
  fireEvent(bar, pointer(window, "pointerdown", start.left, start.top));
};

const movePointer = ({ bar, window }: DragPage, x: number, y: number): void => {
  fireEvent(bar, pointer(window, "pointermove", x, y));
};

const releasePointer = ({ bar, window }: DragPage): void => {
  fireEvent(bar, pointer(window, "pointerup", 0, 0));
};

/** Click a part of the page, as a person does. */
const click = (target: Element, window: Window): void => {
  fireEvent(target, new window.MouseEvent("click", { bubbles: true }));
};

/** An event from the installed DOM, which the client code's own types do not
 *  name. */
type DomEvent = InstanceType<Window["Event"]>;

/** Dispatch one event at a target and hand the event back, so a test can read
 *  what the handler did to it. */
const fire = (
  target: { dispatchEvent(event: unknown): unknown },
  window: Window,
  type: string,
  options: { cancelable?: boolean } = {},
): DomEvent => {
  const event = new window.Event(type, options);
  fireEvent(target, event);
  return event;
};

afterEach(async () => {
  closeDialogs(document, "dialog.admin-modal");
  await cleanup();
});

describe("the admin modal shell", () => {
  test("opens a window with its title, its controls, and the content", () => {
    const window = page();
    const content = document.createElement("div");
    content.textContent = "Preview text";
    openAdminModal(SETTINGS, content);

    const dialog = requireElement<HTMLDialogElement>(
      window.document,
      "dialog.admin-modal",
    );
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.modalKey).toBe("first");
    const title = requireElement<HTMLElement>(dialog, ".admin-modal-title");
    expect(title.textContent).toBe("First");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
    const buttons = requireElements<HTMLButtonElement>(
      dialog,
      ".admin-modal-controls button",
    );
    // A button without a type submits the form around it. The shell adds one
    // to each control.
    expect(
      buttons.map((button) => [
        button.getAttribute("aria-label"),
        button.getAttribute("type"),
      ]),
    ).toEqual([
      ["Minimise", "button"],
      ["Close", "button"],
    ]);
    expect(
      requireElements<Element>(dialog, "use").map((use) =>
        use.getAttribute("href"),
      ),
    ).toEqual([`${ICONS_PATH}#minus`, `${ICONS_PATH}#x`]);
    expect(
      requireElement<HTMLElement>(dialog, ".admin-modal-body").contains(
        content,
      ),
    ).toBe(true);
  });

  test("refuses settings that break the schema", () => {
    page();
    const broken = [
      { key: "only", title: "T" },
      { collapsedTitle: "C", key: "", title: "T" },
      { collapsedTitle: "C", key: "k", title: "" },
    ];
    for (const settings of broken) {
      expect(() => openAdminModal(settings, document.body)).toThrow(
        v.ValiError,
      );
    }
    const issues = v.safeParse(modalSettingsSchema, broken[1]).issues;
    expect(issues?.map((issue) => issue.message)).toEqual([
      "A modal needs a key",
    ]);
  });

  test("refuses to open without the page's template", () => {
    const window = page("<p>No template here</p>");
    expect(() => open(window)).toThrow("Missing element: template#admin-modal");
  });

  test("raises a modal already open under the same key", () => {
    const window = page();
    const first = open(window);
    const raised = open(window, { ...SETTINGS, title: "Other words" });

    expect(dialogsIn(window)).toHaveLength(1);
    expect(raised).toBe(first);
    expect(window.document.activeElement).toBe(first);
    // The raised window keeps the words it opened with.
    expect(
      requireElement<HTMLElement>(first, ".admin-modal-title").textContent,
    ).toBe("First");
  });

  test("stacks the windows in the order they were used", () => {
    const window = page();
    const first = open(window);
    const second = open(window, OTHER_SETTINGS);
    expect(stackOf(window)).toEqual([1000, 1001]);

    // A press on the window behind brings it forward, and so does focus.
    fireEvent(second, pointer(window, "pointerdown", 10, 10));
    fireEvent(first, new window.Event("focusin", { bubbles: true }));
    expect(stackOf(window)).toEqual([1001, 1000]);
  });

  test("closing one window leaves the rest in order", () => {
    const window = page();
    const first = open(window);
    const second = open(window, OTHER_SETTINGS);
    const third = open(window, { ...OTHER_SETTINGS, key: "third" });

    requireElement<HTMLButtonElement>(second, ".admin-modal-close").click();

    expect(dialogsIn(window).map((dialog) => dialog.dataset.modalKey)).toEqual([
      "first",
      "third",
    ]);
    expect(stackOf(window)).toEqual([1000, 1001]);
    expect(first.isConnected).toBe(true);
    expect(third.isConnected).toBe(true);
    expect(second.isConnected).toBe(false);
  });

  test("releases pointer capture when a drag is cancelled", () => {
    const ready = dragPage();
    pressTitleBar(ready);
    expect(ready.capture.captured).toEqual([7]);
    expect(ready.dialog.classList.contains("is-dragging")).toBe(true);

    movePointer(ready, ready.start.left + 10, ready.start.top + 20);
    expect(placed(ready.dialog)).toEqual({
      left: ready.start.left + 10,
      top: ready.start.top + 20,
    });

    fireEvent(ready.bar, pointer(ready.window, "pointercancel", 0, 0));
    expect(ready.capture.released).toEqual([7]);
    expect(ready.dialog.classList.contains("is-dragging")).toBe(false);
  });

  test("keeps the window inside the screen on every drag move", () => {
    const ready = dragPage();
    pressTitleBar(ready);
    movePointer(ready, 5000, 5000);
    expect(placed(ready.dialog)).toEqual({
      left: ready.window.innerWidth - 300,
      top: ready.window.innerHeight - 200,
    });

    movePointer(ready, -500, -500);
    expect(placed(ready.dialog)).toEqual({ left: 0, top: 0 });
  });

  test("keeps an oversized window's title bar and controls on the screen", () => {
    const ready = dragPage(2000, 2000);
    pressTitleBar(ready);
    movePointer(ready, 50, 50);

    expect(placed(ready.dialog)).toEqual({
      left: ready.window.innerWidth - 2000,
      top: 0,
    });
  });

  test("does not start a drag from a control or with another button", () => {
    const ready = dragPage();
    const close = requireElement<HTMLButtonElement>(
      ready.dialog,
      ".admin-modal-close",
    );
    fireEvent(close, pointer(ready.window, "pointerdown", 10, 10));
    fireEvent(
      ready.bar,
      pointer(ready.window, "pointerdown", 10, 10, { button: 1 }),
    );
    expect(ready.capture.captured).toEqual([]);
    expect(ready.dialog.classList.contains("is-dragging")).toBe(false);
  });

  test("does not drag on a full-screen shape", () => {
    const ready = dragPage();
    Object.defineProperty(ready.window, "matchMedia", {
      value: () => ({ matches: true }),
    });
    pressTitleBar(ready);

    expect(ready.capture.captured).toEqual([]);
  });

  test("ignores a pointer move and a release with no press", () => {
    const ready = dragPage();
    const start = placed(ready.dialog);
    movePointer(ready, 10, 10);
    releasePointer(ready);

    expect(placed(ready.dialog)).toEqual(start);
    expect(ready.capture.released).toEqual([]);
  });

  test("minimises to the title bar and opens again from that bar", () => {
    const ready = dragPage();
    const title = requireElement<HTMLElement>(
      ready.dialog,
      ".admin-modal-title",
    );
    pressTitleBar(ready);
    movePointer(ready, ready.start.left + 20, ready.start.top + 30);
    releasePointer(ready);
    const moved = placed(ready.dialog);

    requireElement<HTMLButtonElement>(
      ready.dialog,
      ".admin-modal-minimise",
    ).click();
    expect(ready.dialog.classList.contains("is-collapsed")).toBe(true);
    expect(title.textContent).toBe("First, small");

    // A click on the body leaves the minimised window as it is.
    click(
      requireElement<HTMLElement>(ready.dialog, ".admin-modal-body"),
      ready.window,
    );
    expect(ready.dialog.classList.contains("is-collapsed")).toBe(true);

    click(ready.bar, ready.window);
    expect(ready.dialog.classList.contains("is-collapsed")).toBe(false);
    expect(title.textContent).toBe("First");
    expect(placed(ready.dialog)).toEqual(moved);
  });

  test("opens a minimised window from its own button, but not from a control", () => {
    const { dialog, window } = oneWindow();
    const minimise = requireElement<HTMLButtonElement>(
      dialog,
      ".admin-modal-minimise",
    );

    minimise.click();
    expect(dialog.classList.contains("is-collapsed")).toBe(true);
    // The bar's own click handler leaves the control's press alone, and the
    // control opens the window.
    minimise.click();
    expect(dialog.classList.contains("is-collapsed")).toBe(false);

    minimise.click();
    requireElement<HTMLButtonElement>(dialog, ".admin-modal-close").click();
    expect(dialogsIn(window)).toHaveLength(0);
  });

  test("warns before the page unloads while any window is open", () => {
    const window = page();
    const first = open(window);
    const second = open(window, OTHER_SETTINGS);

    const leaving = fire(window, window, "beforeunload", { cancelable: true });
    expect(leaving.defaultPrevented).toBe(true);
    expect(Reflect.get(leaving, "returnValue")).toBe("");

    first.close();
    const stillLeaving = fire(window, window, "beforeunload", {
      cancelable: true,
    });
    expect(stillLeaving.defaultPrevented).toBe(true);

    second.close();
    const last = fire(window, window, "beforeunload", { cancelable: true });
    expect(last.defaultPrevented).toBe(false);
  });

  test("keeps a window on the screen after the viewport changes", () => {
    const { dialog, window } = oneWindow();
    setSize(window, 300, 200);

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 300,
    });
    fire(window, window, "resize");

    expect(placed(dialog)).toEqual({ left: 100, top: 100 });
  });
  test("keeps the window on screen after its content grows", () => {
    const window = page();
    let resize: () => void = () => {
      throw new Error("The window has no size observer");
    };
    const NativeObserver = window.ResizeObserver;
    Object.defineProperty(window, "ResizeObserver", {
      value: class extends NativeObserver {
        constructor(callback: () => void) {
          super();
          resize = callback;
        }
      },
    });
    const dialog = open(window);
    const before = placed(dialog);
    setSize(window, 300, window.innerHeight);
    resize();
    expect(placed(dialog)).toEqual({
      left: before.left,
      top: 0,
    });
  });
});
