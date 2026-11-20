/** DOM contracts for the admin modal shell's focus and dim: one thing has the
 * focus, and everything else is dim. */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { fireEvent, requireElement } from "#test-utils/happy-dom.ts";
import {
  cleanupModals,
  dialogsIn,
  OTHER_SETTINGS,
  oneWindow,
  open,
  page,
  pointer,
  stackOf,
  twoWindows,
} from "#test-utils/modal-dom.ts";

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

/** A press on the page behind the windows. */
const pressPage = (window: Window): void => {
  fireEvent(window.document.body, pointer(window, "pointerdown", 5, 5));
};

describe("the admin modal shell's dim", () => {
  afterEach(cleanupModals);

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
});
