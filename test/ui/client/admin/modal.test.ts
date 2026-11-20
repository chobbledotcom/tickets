/** DOM contracts for the admin modal shell. Browser contracts cover layout. */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { openAdminModal } from "#src/ui/client/admin/modal.ts";
import { fireEvent, requireElement, requireElements } from "#test-utils/happy-dom.ts";
import {
  cleanupModals,
  click,
  dialogsIn,
  dragPage,
  fire,
  movePointer,
  OTHER_SETTINGS,
  oneWindow,
  open,
  page,
  placed,
  pointer,
  pressTitleBar,
  releasePointer,
  SETTINGS,
  stackOf,
} from "#test-utils/modal-dom.ts";

describe("the admin modal shell", () => {
  afterEach(cleanupModals);

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
});
