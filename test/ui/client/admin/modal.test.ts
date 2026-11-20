/** DOM contracts for the admin modal shell. Browser contracts cover layout. */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import * as v from "valibot";
import { requireValue } from "#shared/required-value.ts";
import {
  type AdminModalLifecycle,
  closeAdminModal,
  initAdminModalShell,
  isAdminModalOpen,
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

type Open = { dialog: HTMLDialogElement; window: Window };

type DragPage = Open & {
  bar: HTMLElement;
  capture: { captured: number[]; released: number[] };
  start: { left: number; top: number };
};

const page = (html = TEMPLATE): Window => {
  const window = installDom(html);
  initAdminModalShell();
  return window;
};

const dialogsIn = (window: Window): HTMLDialogElement[] =>
  requireElements<HTMLDialogElement>(window.document, "dialog.admin-modal");

/** Read the raised dialog from focus, not DOM insertion order. */
const open = (
  window: Window,
  settings: unknown = SETTINGS,
): HTMLDialogElement => {
  openAdminModal(settings, document.createElement("div"));
  return requireElement<HTMLDialogElement>(window.document, "dialog:focus");
};

const oneWindow = (): Open => {
  const window = page();
  return { dialog: open(window), window };
};

const placed = (dialog: HTMLElement): { left: number; top: number } => ({
  left: Number.parseFloat(dialog.style.getPropertyValue("--admin-modal-left")),
  top: Number.parseFloat(dialog.style.getPropertyValue("--admin-modal-top")),
});

const stackOf = (window: Window): number[] =>
  dialogsIn(window).map((dialog) => Number(dialog.style.zIndex));

/** Give the shell a size to clamp against. A DOM without a layout answers
 *  every rectangle with zeroes. */
const setSize = (window: Window, width: number, height: number): void => {
  for (const dialog of dialogsIn(window)) {
    Object.defineProperty(dialog, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ height, width }),
    });
  }
};

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

const click = (target: Element, window: Window): void => {
  fireEvent(target, new window.MouseEvent("click", { bubbles: true }));
};

/** The state the shell keeps on the window. happy-dom's window type does not
 *  carry the shell's property. */
const lifecycleOf = (window: Window): AdminModalLifecycle | undefined =>
  Reflect.get(window, "adminModalLifecycle");

/** What is dim now: the page's attribute, and the key of each dim window. */
const dimmed = (
  window: Window,
): { page: string | undefined; windows: (string | undefined)[] } => ({
  page: window.document.documentElement.dataset.adminModalPageDim,
  windows: dialogsIn(window)
    .filter((dialog) => dialog.classList.contains("is-dim"))
    .map((dialog) => dialog.dataset.modalKey),
});

const expectDim = (
  window: Window,
  page: string | undefined,
  windows: string[],
): void => {
  expect(dimmed(window)).toEqual({ page, windows });
};

/** A page with two windows open: "first" below "second". */
const twoWindows = (): {
  first: HTMLDialogElement;
  second: HTMLDialogElement;
  window: Window;
} => {
  const window = page();
  const first = open(window);
  const second = open(window, OTHER_SETTINGS);
  return { first, second, window };
};

const pressKey = (target: Element, window: Window, key: string): void => {
  fireEvent(
    target,
    new window.KeyboardEvent("keydown", { bubbles: true, key }),
  );
};

/** A press on the page behind the windows. */
const pressPage = (window: Window): void => {
  fireEvent(window.document.body, pointer(window, "pointerdown", 5, 5));
};

type DomEvent = InstanceType<Window["Event"]>;

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

describe("the admin modal shell", () => {
  afterEach(async () => {
    closeDialogs(document, "dialog.admin-modal");
    await cleanup();
  });

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
    expect(
      requireElements<HTMLButtonElement>(
        dialog,
        ".admin-modal-controls button",
      ).map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Minimise", "Close"]);
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

  test("reopens after native close without a queued old close removing it", () => {
    const window = page();
    const first = open(window);
    first.open = false;
    const second = open(window);
    fireEvent(first, new window.Event("close"));
    expect(second).not.toBe(first);
    expect(second.open).toBe(true);
    expect(dialogsIn(window)).toEqual([second]);
  });

  test("drags the window from its title bar with a captured pointer", () => {
    const ready = dragPage();
    pressTitleBar(ready);
    expect(ready.capture.captured).toEqual([7]);
    expect(ready.dialog.classList.contains("is-dragging")).toBe(true);

    movePointer(ready, ready.start.left, ready.start.top);
    movePointer(ready, ready.start.left, ready.start.top + 20);
    movePointer(ready, ready.start.left + 10, ready.start.top + 20);
    expect(placed(ready.dialog)).toEqual({
      left: ready.start.left + 10,
      top: ready.start.top + 20,
    });

    releasePointer(ready);
    expect(ready.capture.released).toEqual([7]);
    expect(ready.dialog.classList.contains("is-dragging")).toBe(false);
  });

  test("keeps a drag bound to its first pointer", () => {
    const ready = dragPage();
    pressTitleBar(ready);
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
      fireEvent(ready.bar, pointer(ready.window, type, 0, 0, { pointerId: 8 }));
    }
    expect(placed(ready.dialog)).toEqual(ready.start);
    expect(ready.capture.captured).toEqual([7]);
    expect(ready.capture.released).toEqual([]);
    releasePointer(ready);
    expect(ready.capture.released).toEqual([7]);
  });

  for (const stop of ["pointercancel", "lostpointercapture"]) {
    test(`stops the drag after ${stop}`, () => {
      const ready = dragPage();
      pressTitleBar(ready);
      fireEvent(
        ready.bar,
        pointer(ready.window, "lostpointercapture", 0, 0, { pointerId: 8 }),
      );
      movePointer(ready, 100, 120);
      const stopped = placed(ready.dialog);
      fireEvent(ready.bar, pointer(ready.window, stop, 100, 120));
      movePointer(ready, 5000, 5000);
      expect(placed(ready.dialog)).toEqual(stopped);
      expect(ready.dialog.classList.contains("is-dragging")).toBe(false);
      fireEvent(ready.bar, pointer(ready.window, "lostpointercapture", 0, 0));
    });
  }

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
    const ready = dragPage();
    const { dialog, window } = ready;
    pressTitleBar(ready);
    setSize(window, 200, 100);

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 300,
    });
    fire(window, window, "resize");

    movePointer(ready, 5000, 5000);
    expect(placed(dialog)).toEqual({ left: 200, top: 200 });
    releasePointer(ready);
    fire(window, window, "resize");
  });
  test("dims the page and the windows that do not have the focus", () => {
    const window = page();
    expectDim(window, undefined, []);

    open(window);
    expectDim(window, "true", []);

    // The newest window has the focus, so the older one is dim.
    open(window, OTHER_SETTINGS);
    expectDim(window, "true", ["first"]);
  });

  test("a press on the page gives the page the focus and closes nothing", () => {
    const { window } = twoWindows();

    pressPage(window);

    expectDim(window, "false", ["first", "second"]);
    expect(dialogsIn(window)).toHaveLength(2);
    expect(dialogsIn(window).every((dialog) => dialog.open)).toBe(true);
  });

  test("a press inside a window gives it the focus back", () => {
    const { first, window } = twoWindows();
    pressPage(window);

    fireEvent(first, pointer(window, "pointerdown", 10, 10));

    // The pressed window comes to the top and is the only bright thing.
    expectDim(window, "true", ["second"]);
    expect(stackOf(window)).toEqual([1001, 1000]);
  });

  test("focus that moves out of the windows and back moves the dim", () => {
    const { dialog: first, window } = oneWindow();
    const outside = window.document.createElement("button");
    window.document.body.append(outside);

    fireEvent(outside, new window.Event("focusin", { bubbles: true }));
    expectDim(window, "false", ["first"]);

    fireEvent(first, new window.Event("focusin", { bubbles: true }));
    expectDim(window, "true", []);
  });

  test("a press on a page control that stops its events still moves the focus", () => {
    const window = page();
    open(window);
    const control = window.document.createElement("button");
    window.document.body.append(control);
    control.addEventListener("pointerdown", (event) => event.stopPropagation());

    fireEvent(control, pointer(window, "pointerdown", 5, 5));

    expect(dimmed(window).page).toBe("false");
  });

  test("opening or raising a window gives it the focus from the page", () => {
    const window = page();
    open(window);
    pressPage(window);

    // A second open under the same key raises the window that is open.
    open(window);
    expectDim(window, "true", []);

    pressPage(window);
    open(window, OTHER_SETTINGS);
    expectDim(window, "true", ["first"]);
  });

  test("clears the dim when the last window closes", () => {
    const { first, second, window } = twoWindows();

    requireElement<HTMLButtonElement>(second, ".admin-modal-close").click();
    expectDim(window, "true", []);

    requireElement<HTMLButtonElement>(first, ".admin-modal-close").click();
    expectDim(window, undefined, []);
  });

  test("closes the window that has the focus on Escape", () => {
    const { first, second, window } = twoWindows();

    pressKey(second, window, "Tab");
    expect(second.isConnected).toBe(true);
    pressKey(second, window, "Escape");

    expect(second.isConnected).toBe(false);
    expect(first.isConnected).toBe(true);
  });

  test("keeps the window open while canClose says no", () => {
    const window = page();
    const allowed = { close: false };
    openAdminModal(SETTINGS, document.createElement("div"), {
      canClose: () => allowed.close,
    });
    const dialog = requireElement<HTMLDialogElement>(
      window.document,
      "dialog.admin-modal",
    );

    requireElement<HTMLButtonElement>(dialog, ".admin-modal-close").click();
    pressKey(dialog, window, "Escape");
    expect(dialog.open).toBe(true);
    expect(isAdminModalOpen("first")).toBe(true);

    allowed.close = true;
    pressKey(dialog, window, "Escape");
    expect(dialog.open).toBe(false);
    expect(isAdminModalOpen("first")).toBe(false);
  });

  test("closes from code without asking canClose", () => {
    const window = page();
    openAdminModal(SETTINGS, document.createElement("div"), {
      canClose: () => false,
    });

    closeAdminModal("first");

    expect(dialogsIn(window)).toHaveLength(0);
    expect(isAdminModalOpen("first")).toBe(false);
    // A window that is already gone is not an error.
    closeAdminModal("first");
  });

  test("runs onClose once, however the window closes", () => {
    const window = page();
    const closes: string[] = [];
    const openWithHook = (label: string): HTMLDialogElement => {
      openAdminModal(SETTINGS, document.createElement("div"), {
        onClose: () => closes.push(label),
      });
      return requireElement<HTMLDialogElement>(
        window.document,
        "dialog.admin-modal",
      );
    };

    const byControl = openWithHook("control");
    requireElement<HTMLButtonElement>(byControl, ".admin-modal-close").click();
    openWithHook("code");
    closeAdminModal("first");
    const byNative = openWithHook("native");
    byNative.close();

    expect(closes).toEqual(["control", "code", "native"]);
  });

  test("keeps the hooks a window opened with when it is raised", () => {
    const window = page();
    const closes: string[] = [];
    openAdminModal(SETTINGS, document.createElement("div"), {
      onClose: () => closes.push("first hook"),
    });
    openAdminModal(SETTINGS, document.createElement("div"), {
      onClose: () => closes.push("second hook"),
    });

    closeAdminModal("first");

    expect(closes).toEqual(["first hook"]);
    expect(dialogsIn(window)).toHaveLength(0);
  });

  test("keeps its state on the window, so every bundle's copy shares it", () => {
    const window = page();
    expect(lifecycleOf(window)).toBeUndefined();

    open(window);
    open(window, OTHER_SETTINGS);

    // A second copy of the module reads the same state and sees both windows.
    expect([
      ...requireValue(lifecycleOf(window), "the shared state").shells.keys(),
    ]).toEqual(["first", "second"]);
  });

  test("knows which windows are open", () => {
    page();
    expect(isAdminModalOpen("first")).toBe(false);
    openAdminModal(SETTINGS, document.createElement("div"));
    expect(isAdminModalOpen("first")).toBe(true);
    expect(isAdminModalOpen("second")).toBe(false);
  });
});
