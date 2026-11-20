import type { Window } from "happy-dom";
import {
  initAdminModalShell,
  openAdminModal,
} from "#src/ui/client/admin/modal.ts";
import { AdminModalTemplate } from "#templates/admin/modal.tsx";
import {
  createDomInstaller,
  fireEvent,
  requireElement,
  requireElements,
} from "#test-utils/happy-dom.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

const TEMPLATE = await withRequestContext(() => String(AdminModalTemplate()));
const { installDom, cleanup } = createDomInstaller(["Element"]);

export { cleanup };

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

type Open = { dialog: HTMLDialogElement; window: Window };

type DragPage = Open & {
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

export const oneWindow = (): Open => {
  const window = page();
  return { dialog: open(window), window };
};

export const placed = (dialog: HTMLElement): { left: number; top: number } => ({
  left: Number.parseFloat(dialog.style.getPropertyValue("--admin-modal-left")),
  top: Number.parseFloat(dialog.style.getPropertyValue("--admin-modal-top")),
});

export const stackOf = (window: Window): number[] =>
  dialogsIn(window).map((dialog) => Number(dialog.style.zIndex));

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
