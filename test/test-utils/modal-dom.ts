/**
 * Shared page helpers for the admin modal shell's DOM suites: the window
 * markup, the settings of two windows, and the readers and presses that the
 * suites share. The shell keeps its state on the page's window, so each
 * suite starts from a fresh page.
 */

import type { Window } from "happy-dom";
import {
  initAdminModalShell,
  openAdminModal,
} from "#src/ui/client/admin/modal.ts";
import { AdminModalTemplate } from "#templates/admin/modal.tsx";
import {
  closeDialogs,
  createDomInstaller,
  requireElement,
  requireElements,
} from "#test-utils/happy-dom.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

const TEMPLATE = await withRequestContext(() => String(AdminModalTemplate()));

const installer = createDomInstaller(["Element"]);

const { installDom } = installer;

/** Closes the windows that a test left open, then restores the globals. For
 * the suite's `afterEach`. */
export const cleanupModals = async (): Promise<void> => {
  closeDialogs(document, "dialog.admin-modal");
  await installer.cleanup();
};

export const SETTINGS = {
  collapsedTitle: "First, small",
  key: "first",
  title: "First",
};

export const OTHER_SETTINGS = {
  collapsedTitle: "Second, small",
  key: "second",
  title: "Second",
};

export type OpenWindow = { dialog: HTMLDialogElement; window: Window };

export const page = (html = TEMPLATE): Window => {
  const window = installDom(html);
  initAdminModalShell();
  return window;
};

export const dialogsIn = (window: Window): HTMLDialogElement[] =>
  requireElements<HTMLDialogElement>(window.document, "dialog.admin-modal");

/** Read the raised dialog from focus, not DOM insertion order. */
export const open = (
  window: Window,
  settings: unknown = SETTINGS,
): HTMLDialogElement => {
  openAdminModal(settings, document.createElement("div"));
  return requireElement<HTMLDialogElement>(window.document, "dialog:focus");
};

export const oneWindow = (): OpenWindow => {
  const window = page();
  return { dialog: open(window), window };
};

/** A page with two windows open: "first" below "second". */
export const twoWindows = (): {
  first: HTMLDialogElement;
  second: HTMLDialogElement;
  window: Window;
} => {
  const window = page();
  const first = open(window);
  const second = open(window, OTHER_SETTINGS);
  return { first, second, window };
};

export const stackOf = (window: Window): number[] =>
  dialogsIn(window).map((dialog) => Number(dialog.style.zIndex));

export const pointer = (
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
