/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Non-modal admin windows. The pure lifecycle owns order and positions, and
 * the pure focus rule owns what is dim. This module owns native dialogs,
 * focus, pointer capture, and page events. One thing has the focus: a window
 * or the page. A press or focus outside the windows moves the focus to the
 * page and closes nothing. */

import * as v from "valibot";
import { requiredMapValue } from "#fp";
import {
  ADMIN_MODAL_TEMPLATE_ID,
  type ModalSettings,
  modalSettingsSchema,
} from "#shared/admin-modal.ts";
import { requireValue } from "#shared/required-value.ts";
import { dimmingFor } from "#src/ui/client/admin/modal-focus.ts";
import {
  centredPosition,
  type ModalSize,
  type Point,
} from "#src/ui/client/admin/modal-position.ts";
import {
  type ModalEvent,
  type ModalState,
  transitionModals,
} from "#src/ui/client/admin/modal-state.ts";
import { cloneContent, requiredChild } from "#src/ui/client/dom.ts";
import "#src/ui/client/window-globals.ts";

// The stylesheet uses the same query.
const FULL_SCREEN_QUERY = "(max-width: 768px), (pointer: coarse)";
// The stylesheet's page dim sits at one below this number.
const Z_INDEX_BASE = 1000;

/** What a window asks of its opener. A window that is already open keeps the
 * hooks it opened with.
 *
 *  - `canClose` is asked when the close control or Escape closes the window.
 *    A false answer keeps it open. A close from code does not ask.
 *  - `onClose` runs once after the window is gone, however it closed. */
export type ModalHooks = {
  canClose?: () => boolean;
  onClose?: () => void;
};

const ALWAYS_CLOSABLE = (): boolean => true;
const NOTHING_TO_DO = (): void => undefined;

type Drag = {
  offset: Point;
  pointerId: number;
  size: ModalSize;
};

type Shell = {
  bar: HTMLElement;
  canClose: () => boolean;
  content: HTMLElement;
  controls: HTMLElement;
  dialog: HTMLDialogElement;
  drag: Drag | null;
  dragMoved: boolean;
  observer: ResizeObserver;
  onClose: () => void;
  rendered: ModalState | null;
  settings: ModalSettings;
  title: HTMLElement;
};

/** The state that every window shares: the stack, the focus, and the shells.
 * It lives on the window, because the admin bundle and the markdown editor
 * bundle each carry a copy of this module. */
export type AdminModalLifecycle = {
  pageFocused: boolean;
  shellCount: number;
  shells: Map<string, Shell>;
  states: readonly ModalState[];
};

const getLifecycle = (): AdminModalLifecycle => {
  window.adminModalLifecycle ??= {
    pageFocused: false,
    shellCount: 0,
    shells: new Map(),
    states: [],
  };
  return window.adminModalLifecycle;
};

const viewportSize = (): ModalSize => ({
  height: window.innerHeight,
  width: window.innerWidth,
});

const measure = (dialog: HTMLDialogElement): ModalSize =>
  dialog.getBoundingClientRect();

const stateFor = (shell: Shell): ModalState => {
  const { states } = getLifecycle();
  return requireValue(
    states.find((state) => state.key === shell.settings.key),
    "The modal state is absent.",
  );
};

/** Dims the page when a window has the focus, and every window but the one
 * that has it. The attribute is absent while no window is open. */
const renderDimming = (): void => {
  const { pageFocused, shells, states } = getLifecycle();
  const dimming = dimmingFor(
    states.map(({ key }) => key),
    pageFocused,
  );
  for (const [key, { dialog }] of shells) {
    dialog.classList.toggle("is-dim", dimming.windows.has(key));
  }
  const { dataset } = document.documentElement;
  if (states.length === 0) {
    delete dataset.adminModalPageDim;
    return;
  }
  const value = String(dimming.page);
  if (dataset.adminModalPageDim !== value) dataset.adminModalPageDim = value;
};

const setPageFocused = (pageFocused: boolean): void => {
  getLifecycle().pageFocused = pageFocused;
  renderDimming();
};

const apply = (event: ModalEvent): void => {
  const lifecycle = getLifecycle();
  const { shells } = lifecycle;
  const next = transitionModals(lifecycle.states, event);
  if (next === lifecycle.states) return;
  lifecycle.states = next;
  for (const [index, state] of next.entries()) {
    const shell = requiredMapValue(
      shells,
      state.key,
      "The modal shell is absent.",
    );
    const { dialog, rendered } = shell;
    const zIndex = String(Z_INDEX_BASE + index);
    if (dialog.style.zIndex !== zIndex) dialog.style.zIndex = zIndex;
    if (rendered?.point !== state.point) {
      dialog.style.setProperty("--admin-modal-left", `${state.point.left}px`);
      dialog.style.setProperty("--admin-modal-top", `${state.point.top}px`);
    }
    if (
      rendered === null ||
      (rendered.expandedPoint === null) !== (state.expandedPoint === null)
    ) {
      const collapsed = state.expandedPoint !== null;
      dialog.classList.toggle("is-collapsed", collapsed);
      shell.title.textContent = collapsed
        ? shell.settings.collapsedTitle
        : shell.settings.title;
    }
    shell.rendered = state;
  }
};

// One listener serves every bundle's windows. It asks the shared state, so a
// copy of this module that opened no window still answers for them.
const warnBeforeLeave = (event: BeforeUnloadEvent): void => {
  if (getLifecycle().shells.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
};

const removeShell = (shell: Shell): void => {
  const { shells } = getLifecycle();
  const { key } = shell.settings;
  // A native close event can arrive after the same key opens a new window.
  if (shells.get(key) !== shell) return;
  shell.observer.disconnect();
  shells.delete(key);
  shell.dialog.remove();
  apply({ key, type: "close" });
  renderDimming();
  shell.onClose();
};

const closeShell = (shell: Shell): void => {
  // Close before removal so the browser can return focus to the opener.
  shell.dialog.close();
  removeShell(shell);
};

const requestClose = (shell: Shell): void => {
  if (shell.canClose()) closeShell(shell);
};

/** Gives the focus to one window and raises it. */
const focusWindow = (shell: Shell): void => {
  getLifecycle().pageFocused = false;
  apply({ key: shell.settings.key, type: "raise" });
  renderDimming();
};

const restore = (shell: Shell): void => {
  // Measure the expanded layout before the lifecycle clamps its saved point.
  shell.dialog.classList.remove("is-collapsed");
  apply({
    key: shell.settings.key,
    size: measure(shell.dialog),
    type: "restore",
    viewport: viewportSize(),
  });
};

const toggleCollapsed = (shell: Shell): void => {
  if (stateFor(shell).expandedPoint !== null) restore(shell);
  else apply({ key: shell.settings.key, type: "minimise" });
};

const beganOnBar = (shell: Shell, event: Event): boolean => {
  const path = event.composedPath();
  return path.includes(shell.bar) && !path.includes(shell.controls);
};

const restoreOnBarClick = (shell: Shell, event: MouseEvent): void => {
  if (shell.dragMoved) {
    shell.dragMoved = false;
    return;
  }
  if (beganOnBar(shell, event) && stateFor(shell).expandedPoint !== null) {
    restore(shell);
  }
};

type DragHandler = (shell: Shell, event: PointerEvent) => void;

const startDrag: DragHandler = (shell, event) => {
  if (shell.drag !== null || event.button !== 0) return;
  shell.dragMoved = false;
  if (
    window.matchMedia(FULL_SCREEN_QUERY).matches ||
    !beganOnBar(shell, event)
  ) {
    return;
  }
  const { point } = stateFor(shell);
  shell.drag = {
    offset: {
      left: event.clientX - point.left,
      top: event.clientY - point.top,
    },
    pointerId: event.pointerId,
    size: measure(shell.dialog),
  };
  shell.dialog.classList.add("is-dragging");
  shell.bar.setPointerCapture(event.pointerId);
};

const dragMove: DragHandler = (shell, event) => {
  const { drag } = shell;
  if (drag === null || event.pointerId !== drag.pointerId) return;
  const before = stateFor(shell).point;
  apply({
    key: shell.settings.key,
    point: {
      left: event.clientX - drag.offset.left,
      top: event.clientY - drag.offset.top,
    },
    size: drag.size,
    type: "move",
    viewport: viewportSize(),
  });
  const after = stateFor(shell).point;
  shell.dragMoved ||= before.left !== after.left || before.top !== after.top;
};

const clearDrag = (shell: Shell): void => {
  shell.drag = null;
  shell.dialog.classList.remove("is-dragging");
};

const endDrag: DragHandler = (shell, event) => {
  if (shell.drag === null || event.pointerId !== shell.drag.pointerId) return;
  shell.bar.releasePointerCapture(event.pointerId);
  clearDrag(shell);
};

const clampOpenShells = (): void => {
  const { shells } = getLifecycle();
  const sizes = new Map<string, ModalSize>();
  for (const [key, shell] of shells) {
    const size = measure(shell.dialog);
    sizes.set(key, size);
    if (shell.drag !== null) shell.drag.size = size;
  }
  apply({ sizes, type: "resize", viewport: viewportSize() });
};

const wireEvents = (shell: Shell): void => {
  const { dialog, bar } = shell;
  requiredChild(dialog, ".admin-modal-close").addEventListener("click", () =>
    requestClose(shell),
  );
  requiredChild(dialog, ".admin-modal-minimise").addEventListener("click", () =>
    toggleCollapsed(shell),
  );
  dialog.addEventListener("pointerdown", (event) => {
    focusWindow(shell);
    startDrag(shell, event);
  });
  dialog.addEventListener("pointermove", (event) => dragMove(shell, event));
  dialog.addEventListener("pointerup", (event) => endDrag(shell, event));
  dialog.addEventListener("pointercancel", (event) => endDrag(shell, event));
  bar.addEventListener("lostpointercapture", (event) => {
    if (shell.drag?.pointerId === event.pointerId) clearDrag(shell);
  });
  dialog.addEventListener("click", (event) => restoreOnBarClick(shell, event));
  dialog.addEventListener("focusin", () => focusWindow(shell));
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") requestClose(shell);
  });
  dialog.addEventListener("close", () => removeShell(shell));
};

const createShell = (
  settings: ModalSettings,
  content: HTMLElement,
  { canClose, onClose }: Required<ModalHooks>,
): Shell => {
  const template = requiredChild<HTMLTemplateElement>(
    document,
    `template#${ADMIN_MODAL_TEMPLATE_ID}`,
  );
  const dialog = requiredChild<HTMLDialogElement>(
    cloneContent(template.content),
    "dialog",
  );
  dialog.dataset.modalKey = settings.key;
  const title = requiredChild<HTMLElement>(dialog, ".admin-modal-title");
  title.id = `${ADMIN_MODAL_TEMPLATE_ID}-title-${++getLifecycle().shellCount}`;
  title.textContent = settings.title;
  dialog.setAttribute("aria-labelledby", title.id);
  requiredChild(dialog, ".admin-modal-body").append(content);
  const shell: Shell = {
    bar: requiredChild(dialog, ".admin-modal-bar"),
    canClose,
    content,
    controls: requiredChild(dialog, ".admin-modal-controls"),
    dialog,
    drag: null,
    dragMoved: false,
    observer: new window.ResizeObserver(clampOpenShells),
    onClose,
    rendered: null,
    settings,
    title,
  };
  wireEvents(shell);
  document.body.append(dialog);
  return shell;
};

/** Whether the window with this key is open now. */
export const isAdminModalOpen = (key: string): boolean =>
  getLifecycle().shells.get(key)?.dialog.open === true;

/** Closes the window with this key without asking `canClose`. A key that is
 * not open is a window that already closed, so it does nothing. */
export const closeAdminModal = (key: string): void => {
  const shell = getLifecycle().shells.get(key);
  if (shell !== undefined) closeShell(shell);
};

export const openAdminModal = (
  settings: unknown,
  content: HTMLElement,
  { canClose = ALWAYS_CLOSABLE, onClose = NOTHING_TO_DO }: ModalHooks = {},
): HTMLElement => {
  const { shells } = getLifecycle();
  const parsed = v.parse(modalSettingsSchema, settings);
  const existing = shells.get(parsed.key);
  if (existing !== undefined) {
    if (existing.dialog.open) {
      focusWindow(existing);
      existing.dialog.focus();
      return existing.content;
    }
    removeShell(existing);
  }
  const shell = createShell(parsed, content, { canClose, onClose });
  shells.set(parsed.key, shell);
  shell.dialog.show();
  getLifecycle().pageFocused = false;
  apply({
    key: parsed.key,
    point: centredPosition(measure(shell.dialog), viewportSize()),
    type: "open",
  });
  renderDimming();
  // Fetched content and images can change the window size after it opens.
  shell.observer.observe(shell.dialog);
  shell.dialog.focus();
  return shell.content;
};

const focusPageOutsideWindows = (event: Event): void => {
  const path = event.composedPath();
  const inWindow = [...getLifecycle().shells.values()].some(({ dialog }) =>
    path.includes(dialog),
  );
  if (!inWindow) setPageFocused(true);
};

export const initAdminModalShell = (): void => {
  window.addEventListener("resize", clampOpenShells);
  window.addEventListener("beforeunload", warnBeforeLeave);
  // A press on the page gives the page the focus and nothing more. The
  // capture phase sees it even when a page control stops its own events.
  document.addEventListener("pointerdown", focusPageOutsideWindows, true);
  document.addEventListener("focusin", focusPageOutsideWindows);
};
