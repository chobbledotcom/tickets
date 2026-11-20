/** DOM contracts for the admin modal shell's close hooks: Escape, `canClose`,
 * `onClose`, and the shared state that the shell keeps on the window. */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { requireValue } from "#shared/required-value.ts";
import {
  type AdminModalLifecycle,
  closeAdminModal,
  isAdminModalOpen,
  openAdminModal,
} from "#src/ui/client/admin/modal.ts";
import { fireEvent, requireElement } from "#test-utils/happy-dom.ts";
import {
  cleanupModals,
  dialogsIn,
  OTHER_SETTINGS,
  open,
  page,
  SETTINGS,
  twoWindows,
} from "#test-utils/modal-dom.ts";

/** The state the shell keeps on the window. happy-dom's window type does not
 *  carry the shell's property. */
const lifecycleOf = (window: Window): AdminModalLifecycle | undefined =>
  Reflect.get(window, "adminModalLifecycle");

const pressKey = (target: Element, window: Window, key: string): void => {
  fireEvent(
    target,
    new window.KeyboardEvent("keydown", { bubbles: true, key }),
  );
};

describe("the admin modal shell's close hooks", () => {
  afterEach(cleanupModals);

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
    expect(Reflect.has(window, "adminModalLifecycle")).toBe(false);

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
