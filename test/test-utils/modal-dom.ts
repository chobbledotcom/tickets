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
  fireEvent,
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

export type DragPage = OpenWindow & {
  bar: HTMLElement;
  capture: { captured: number[]; released: number[] };
  start: { left: number; top: number };
};

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

export const placed = (dialog: HTMLElement): { left: number; top: number } => ({
  left: Number.parseFloat(dialog.style.getPropertyValue("--admin-modal-left")),
  top: Number.parseFloat(dialog.style.getPropertyValue("--admin-modal-top")),
});

/** Give the shell a size to clamp against. A DOM without a layout answers
 *  every rectangle with zeroes. */
export const setSize = (
  window: Window,
  width: number,
  height: number,
): void => {
  for (const dialog of dialogsIn(window)) {
    Object.defineProperty(dialog, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ height, width }),
    });
  }
};

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

export const dragPage = (width = 300, height = 200): DragPage => {
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

export const pressTitleBar = ({ bar, start, window }: DragPage): void => {
  fireEvent(bar, pointer(window, "pointerdown", start.left, start.top));
};

export const movePointer = (
  { bar, window }: DragPage,
  x: number,
  y: number,
): void => {
  fireEvent(bar, pointer(window, "pointermove", x, y));
};

export const releasePointer = ({ bar, window }: DragPage): void => {
  fireEvent(bar, pointer(window, "pointerup", 0, 0));
};

export const click = (target: Element, window: Window): void => {
  fireEvent(target, new window.MouseEvent("click", { bubbles: true }));
};

type DomEvent = InstanceType<Window["Event"]>;

export const fire = (
  target: { dispatchEvent(event: unknown): unknown },
  window: Window,
  type: string,
  options: { cancelable?: boolean } = {},
): DomEvent => {
  const event = new window.Event(type, options);
  fireEvent(target, event);
  return event;
};
