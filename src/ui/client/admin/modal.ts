/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The shared admin modal shell. A modal is a window the operator can drag and
 * stack over an admin page.
 *
 * The window is a non-modal `<dialog>`. The page behind it stays usable, and
 * Escape does not close it, because the operator closes it with its own
 * control. Every modal validates its settings at construction. A second open
 * with the same key raises the modal already open under that key. The markup
 * and copy come from the inert `<template>` that the admin shell renders.
 */

import * as v from "valibot";
import {
  ADMIN_MODAL_TEMPLATE_ID,
  ADMIN_MODAL_TITLE_ID,
  type ModalSettings,
  modalSettingsSchema,
} from "#shared/admin-modal.ts";
import {
  centredPosition,
  clampModalPosition,
  type ModalSize,
  type Point,
} from "#src/ui/client/admin/modal-position.ts";
import { requiredChild } from "#src/ui/client/dom.ts";

/** The z-index of the bottom modal. Each modal above it adds one, so the open
 *  list drives the stack. */
const Z_INDEX_BASE = 1000;

/** The screen shape that shows a modal full screen, where dragging is off.
 *  The stylesheet carries the same query in `_modal.scss`. */
const FULL_SCREEN_QUERY = "(max-width: 768px), (pointer: coarse)";

/** A drag that is in progress. */
type Drag = {
  /** Where the pointer holds the modal, from its top-left corner. */
  offsetX: number;
  offsetY: number;
  pointerId: number;
  /** The modal's size at the start of the drag, measured once. */
  size: ModalSize;
};

/** The parts of one open modal, and the points it holds. */
type Shell = {
  bar: HTMLElement;
  body: HTMLElement;
  content: HTMLElement;
  /** The two icon buttons, which a press must not turn into a drag. */
  controls: HTMLElement;
  dialog: HTMLDialogElement;
  drag: Drag | null;
  /** Where the modal sat before it was minimised. */
  expandedPoint: Point;
  /** Where the modal sits now. */
  point: Point;
  settings: ModalSettings;
  title: HTMLElement;
};

/** What a caller holds after it opens a modal. */
export type AdminModal = {
  /** Closes the modal, the way its close control does. */
  close: () => void;
  /** The content element the modal shows. A caller updates this element to
   *  change what the operator reads. */
  content: HTMLElement;
  settings: ModalSettings;
};

/** Every open modal, bottom first. The stack order and the leave warning both
 *  read this list. A raise moves one modal to the end. */
const openShells: Shell[] = [];

/** The count that keeps each modal's title id unique on the page. */
let shellCount = 0;

/** The screen the modal must stay inside. */
const viewportSize = (): ModalSize => ({
  height: window.innerHeight,
  width: window.innerWidth,
});

/** The modal's current size. Read when a drag starts and after a resize,
 *  because a read forces the page to lay out. */
const measure = (dialog: HTMLDialogElement): ModalSize => {
  const rect = dialog.getBoundingClientRect();
  return { height: rect.height, width: rect.width };
};

/** Move the modal to a point that keeps it on the screen. */
const moveTo = (shell: Shell, point: Point, size: ModalSize): void => {
  const placed = clampModalPosition(point, size, viewportSize());
  shell.point = placed;
  // Custom properties, not left and top: the full-screen rule then wins over
  // them without a heavier selector.
  shell.dialog.style.setProperty("--admin-modal-left", `${placed.left}px`);
  shell.dialog.style.setProperty("--admin-modal-top", `${placed.top}px`);
};

/** Rearrange the z-index of every open modal from the open list. */
const restack = (): void => {
  for (const [index, shell] of openShells.entries()) {
    shell.dialog.style.zIndex = String(Z_INDEX_BASE + index);
  }
};

/** Put one open modal on top and focus it. */
const raise = (shell: Shell): void => {
  const index = openShells.indexOf(shell);
  if (index === openShells.length - 1) return;
  openShells.splice(index, 1);
  openShells.push(shell);
  restack();
};

/** The state that a minimised modal is in. */
const isCollapsed = (shell: Shell): boolean =>
  shell.dialog.classList.contains("is-collapsed");

/** Show the modal as minimised or open, with the bar words for that state. */
const setCollapsed = (shell: Shell, collapsed: boolean): void => {
  shell.dialog.classList.toggle("is-collapsed", collapsed);
  if (collapsed) {
    shell.title.textContent = shell.settings.collapsedTitle;
    return;
  }
  shell.title.textContent = shell.settings.title;
};

/** Minimise the modal to its title bar. */
const collapse = (shell: Shell): void => {
  shell.expandedPoint = shell.point;
  setCollapsed(shell, true);
};

/** Open a minimised modal at the point it held before. */
const restore = (shell: Shell): void => {
  setCollapsed(shell, false);
  moveTo(shell, shell.expandedPoint, measure(shell.dialog));
};

/** Minimise an open modal, and open a minimised one. */
const toggleCollapsed = (shell: Shell): void => {
  if (isCollapsed(shell)) {
    restore(shell);
    return;
  }
  collapse(shell);
};

/** Whether the event happened inside one part, whatever element it started
 *  on. The composed path answers for every depth. */
const happenedInside = (event: Event, part: Element): boolean =>
  event.composedPath().includes(part);

/** Whether the event began on the title bar itself, away from its controls.
 *  A press on a control belongs to the control, not to the bar. */
const beganOnBar = (shell: Shell, event: Event): boolean =>
  happenedInside(event, shell.bar) && !happenedInside(event, shell.controls);

/** A click on a minimised bar opens the modal again. */
const restoreOnBarClick = (shell: Shell, event: MouseEvent): void => {
  if (!isCollapsed(shell)) return;
  if (!beganOnBar(shell, event)) return;
  restore(shell);
};

/** Start a drag from the title bar, unless the screen or the press forbids
 *  it. */
const startDrag = (shell: Shell, event: PointerEvent): void => {
  if (event.button !== 0) return;
  if (window.matchMedia(FULL_SCREEN_QUERY).matches) return;
  if (!beganOnBar(shell, event)) return;
  shell.drag = {
    offsetX: event.clientX - shell.point.left,
    offsetY: event.clientY - shell.point.top,
    pointerId: event.pointerId,
    size: measure(shell.dialog),
  };
  shell.dialog.classList.add("is-dragging");
  shell.bar.setPointerCapture(event.pointerId);
};

/** A press raises the modal. A press that lands on the title bar also starts
 *  a drag. */
const pressOn = (shell: Shell, event: PointerEvent): void => {
  raise(shell);
  startDrag(shell, event);
};

/** Follow the pointer with the modal, kept on the screen. */
const dragMove = (shell: Shell, event: PointerEvent): void => {
  if (shell.drag === null) return;
  moveTo(
    shell,
    {
      left: event.clientX - shell.drag.offsetX,
      top: event.clientY - shell.drag.offsetY,
    },
    shell.drag.size,
  );
};

/** Finish a drag and release the pointer. */
const endDrag = (shell: Shell): void => {
  if (shell.drag === null) return;
  shell.bar.releasePointerCapture(shell.drag.pointerId);
  shell.drag = null;
  shell.dialog.classList.remove("is-dragging");
};

/** Stop the browser from leaving the page while a modal is open. The browser
 *  supplies the warning words. */
const warnBeforeLeave = (event: BeforeUnloadEvent): void => {
  event.preventDefault();
  event.returnValue = "";
};

/** Keep the warning while a modal is open, and drop it after the last one
 *  closes. */
const syncLeaveWarning = (): void => {
  if (openShells.length === 0) {
    window.removeEventListener("beforeunload", warnBeforeLeave);
    return;
  }
  window.addEventListener("beforeunload", warnBeforeLeave);
};

/** Forget a closed modal and leave the rest in order. */
const removeShell = (shell: Shell): void => {
  openShells.splice(openShells.indexOf(shell), 1);
  shell.dialog.remove();
  restack();
  syncLeaveWarning();
};

/** Keep every open modal on the screen after the viewport changes. */
const clampOpenShells = (): void => {
  for (const shell of openShells) {
    moveTo(shell, shell.point, measure(shell.dialog));
  }
};

/** Join the close and minimise controls to what they do. */
const wireControls = (shell: Shell): void => {
  const close = requiredChild<HTMLButtonElement>(
    shell.dialog,
    ".admin-modal-close",
  );
  const minimise = requiredChild<HTMLButtonElement>(
    shell.dialog,
    ".admin-modal-minimise",
  );
  close.addEventListener("click", () => shell.dialog.close());
  minimise.addEventListener("click", () => toggleCollapsed(shell));
};

/** Join the window's own events to what they do. The dialog listens for every
 *  event, so a press on the body still raises the modal. */
const wireEvents = (shell: Shell): void => {
  const { dialog } = shell;
  dialog.addEventListener("pointerdown", (event) => pressOn(shell, event));
  dialog.addEventListener("pointermove", (event) => dragMove(shell, event));
  dialog.addEventListener("pointerup", () => endDrag(shell));
  dialog.addEventListener("pointercancel", () => endDrag(shell));
  dialog.addEventListener("click", (event) => restoreOnBarClick(shell, event));
  dialog.addEventListener("focusin", () => raise(shell));
  dialog.addEventListener("close", () => removeShell(shell));
};

/** Build one modal from the template, wire its controls, and add it to the
 *  page. It is not shown yet. */
const createShell = (settings: ModalSettings, content: HTMLElement): Shell => {
  const template = requiredChild<HTMLTemplateElement>(
    document,
    `template#${ADMIN_MODAL_TEMPLATE_ID}`,
  );
  const fragment = document.importNode(template.content, true);
  const dialog = requiredChild<HTMLDialogElement>(fragment, "dialog");
  shellCount += 1;
  dialog.dataset.modalKey = settings.key;
  dialog.setAttribute(
    "aria-labelledby",
    `${ADMIN_MODAL_TITLE_ID}-${shellCount}`,
  );

  const title = requiredChild<HTMLElement>(dialog, ".admin-modal-title");
  title.id = `${ADMIN_MODAL_TITLE_ID}-${shellCount}`;
  title.textContent = settings.title;

  const body = requiredChild<HTMLElement>(dialog, ".admin-modal-body");
  body.append(content);

  const bar = requiredChild<HTMLElement>(dialog, ".admin-modal-bar");
  const controls = requiredChild<HTMLElement>(dialog, ".admin-modal-controls");

  const shell: Shell = {
    bar,
    body,
    content,
    controls,
    dialog,
    drag: null,
    expandedPoint: { left: 0, top: 0 },
    point: { left: 0, top: 0 },
    settings,
    title,
  };

  wireControls(shell);
  wireEvents(shell);
  document.body.append(dialog);
  return shell;
};

/** The handle an open modal gives its caller. */
const handleFor = (shell: Shell): AdminModal => ({
  close: () => shell.dialog.close(),
  content: shell.content,
  settings: shell.settings,
});

/** Open a modal, or raise and focus the modal already open under its key. */
export const openAdminModal = (
  settings: unknown,
  content: HTMLElement,
): AdminModal => {
  const parsed = v.parse(modalSettingsSchema, settings);
  const existing = openShells.find(
    (shell) => shell.settings.key === parsed.key,
  );
  if (existing !== undefined) {
    raise(existing);
    existing.dialog.focus();
    return handleFor(existing);
  }
  const shell = createShell(parsed, content);
  openShells.push(shell);
  restack();
  shell.dialog.show();
  const size = measure(shell.dialog);
  moveTo(shell, centredPosition(size, viewportSize()), size);
  shell.dialog.focus();
  syncLeaveWarning();
  return handleFor(shell);
};

/** Start the shell on this page. The admin entry point calls this once, before
 *  any page behaviour that can open a modal. */
export const initAdminModalShell = (): void => {
  window.addEventListener("resize", clampOpenShells);
};
