/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Non-modal admin windows. The pure lifecycle owns order and positions.
 * This module owns native dialogs, focus, pointer capture, and page events. */

import * as v from "valibot";
import { once, requiredMapValue } from "#fp";
import {
  ADMIN_MODAL_TEMPLATE_ID,
  type ModalSettings,
  modalSettingsSchema,
} from "#shared/admin-modal.ts";
import { requireValue } from "#shared/required-value.ts";
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

// The stylesheet uses the same query.
const FULL_SCREEN_QUERY = "(max-width: 768px), (pointer: coarse)";
const Z_INDEX_BASE = 1000;

type Drag = {
  offset: Point;
  pointerId: number;
  size: ModalSize;
};

type Shell = {
  bar: HTMLElement;
  content: HTMLElement;
  controls: HTMLElement;
  dialog: HTMLDialogElement;
  drag: Drag | null;
  dragMoved: boolean;
  rendered: ModalState | null;
  settings: ModalSettings;
  title: HTMLElement;
};

const getLifecycle = once(
  (): {
    shells: Map<string, Shell>;
    states: readonly ModalState[];
    shellCount: number;
  } => ({ shellCount: 0, shells: new Map(), states: [] }),
);

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

const warnBeforeLeave = (event: BeforeUnloadEvent): void => {
  event.preventDefault();
  event.returnValue = "";
};

const removeShell = (shell: Shell): void => {
  const { shells } = getLifecycle();
  const { key } = shell.settings;
  // A native close event can arrive after the same key opens a new window.
  if (shells.get(key) !== shell) return;
  shells.delete(key);
  shell.dialog.remove();
  apply({ key, type: "close" });
  if (shells.size === 0) {
    window.removeEventListener("beforeunload", warnBeforeLeave);
  }
};

const closeShell = (shell: Shell): void => {
  // Close before removal so the browser can return focus to the opener.
  shell.dialog.close();
  removeShell(shell);
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
  const { dialog, bar, settings } = shell;
  requiredChild(dialog, ".admin-modal-close").addEventListener("click", () =>
    closeShell(shell),
  );
  requiredChild(dialog, ".admin-modal-minimise").addEventListener("click", () =>
    toggleCollapsed(shell),
  );
  dialog.addEventListener("pointerdown", (event) => {
    apply({ key: settings.key, type: "raise" });
    startDrag(shell, event);
  });
  dialog.addEventListener("pointermove", (event) => dragMove(shell, event));
  dialog.addEventListener("pointerup", (event) => endDrag(shell, event));
  dialog.addEventListener("pointercancel", (event) => endDrag(shell, event));
  bar.addEventListener("lostpointercapture", (event) => {
    if (shell.drag?.pointerId === event.pointerId) clearDrag(shell);
  });
  dialog.addEventListener("click", (event) => restoreOnBarClick(shell, event));
  dialog.addEventListener("focusin", () =>
    apply({ key: settings.key, type: "raise" }),
  );
  dialog.addEventListener("close", () => removeShell(shell));
};

const createShell = (settings: ModalSettings, content: HTMLElement): Shell => {
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
    content,
    controls: requiredChild(dialog, ".admin-modal-controls"),
    dialog,
    drag: null,
    dragMoved: false,
    rendered: null,
    settings,
    title,
  };
  wireEvents(shell);
  document.body.append(dialog);
  return shell;
};

export const openAdminModal = (
  settings: unknown,
  content: HTMLElement,
): HTMLElement => {
  const { shells } = getLifecycle();
  const parsed = v.parse(modalSettingsSchema, settings);
  const existing = shells.get(parsed.key);
  if (existing !== undefined) {
    if (existing.dialog.open) {
      apply({ key: parsed.key, type: "raise" });
      existing.dialog.focus();
      return existing.content;
    }
    removeShell(existing);
  }
  const shell = createShell(parsed, content);
  shells.set(parsed.key, shell);
  shell.dialog.show();
  apply({
    key: parsed.key,
    point: centredPosition(measure(shell.dialog), viewportSize()),
    type: "open",
  });
  shell.dialog.focus();
  window.addEventListener("beforeunload", warnBeforeLeave);
  return shell.content;
};

export const initAdminModalShell = (): void => {
  window.addEventListener("resize", clampOpenShells);
};
