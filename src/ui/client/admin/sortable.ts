/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Drag to reorder any list marked `data-sortable`. Each item carries a
 * `data-sortable-handle` with its own anchor and path. A drag moves the item
 * in the page. The drop posts the same move that the arrows post. It names
 * the item now above, or the item now below. The server stores the order,
 * and the page reloads with it. Pointer Events cover the mouse, touch, and
 * pen.
 */

import type { MovePlace } from "#shared/reorder.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  createHiddenInput,
  forEachMatch,
  requiredChild,
} from "#src/ui/client/dom.ts";

/** The direct child of `list` that holds `node`. */
const itemHolding = (list: HTMLElement, node: Element): HTMLElement =>
  requireValue(
    [...list.children].find((child) => child.contains(node)) as
      | HTMLElement
      | undefined,
    "sortable item",
  );

/** The handle inside one item. */
const handleOf = (item: Element): HTMLElement =>
  requiredChild<HTMLElement>(item, "[data-sortable-handle]");

/** The item under the pointer, other than the one being dragged. */
const itemUnderPointer = (
  list: HTMLElement,
  dragged: HTMLElement,
  event: PointerEvent,
): HTMLElement | null => {
  const node = document.elementFromPoint(event.clientX, event.clientY);
  if (node === null || !list.contains(node) || dragged.contains(node)) {
    return null;
  }
  return itemHolding(list, node);
};

/** Put the dragged item before or after the item under the pointer, by which
 *  half of that item the pointer is over. */
const moveBeside = (
  list: HTMLElement,
  dragged: HTMLElement,
  event: PointerEvent,
): void => {
  const over = itemUnderPointer(list, dragged, event);
  if (over === null) return;
  const box = over.getBoundingClientRect();
  const upperHalf = event.clientY < box.top + box.height / 2;
  list.insertBefore(dragged, upperHalf ? over : over.nextElementSibling);
};

const anchorOf = (item: Element): string =>
  requireValue(handleOf(item).dataset.sortableAnchor, "sortable anchor");

/** The move that puts a moved item where it now sits, named by a neighbour.
 *  A moved item always has one. */
const moveFor = (item: HTMLElement): { anchor: string; place: MovePlace } => {
  const above = item.previousElementSibling;
  return above === null
    ? {
        anchor: anchorOf(requireValue(item.nextElementSibling, "neighbour")),
        place: "before",
      }
    : { anchor: anchorOf(above), place: "after" };
};

/** Post the move form, with the CSRF token the item's arrow forms carry. */
const postMove = (
  list: HTMLElement,
  item: HTMLElement,
  move: { anchor: string; place: MovePlace },
): void => {
  const path = requireValue(handleOf(item).dataset.sortablePath, "path");
  const token = requiredChild<HTMLInputElement>(
    list,
    'input[name="csrfToken"]',
  );
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `${path}/move-${move.place}`;
  form.append(
    createHiddenInput("csrfToken", token.value),
    createHiddenInput("anchor", move.anchor),
  );
  document.body.append(form);
  form.submit();
};

/** Wire one handle: press to pick the item up, move to drag, release to post
 *  the move. A cancelled drag puts the item back. */
const setUpHandle = (list: HTMLElement, handle: HTMLElement): void => {
  handle.hidden = false;
  handle.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    const item = itemHolding(list, handle);
    const before = item.nextElementSibling;
    const onMove = (event: PointerEvent): void => moveBeside(list, item, event);
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const finish = (commit: boolean): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      item.classList.remove("is-dragging");
      if (item.nextElementSibling === before) return;
      if (commit) {
        postMove(list, item, moveFor(item));
      } else {
        list.insertBefore(item, before);
      }
    };
    handle.setPointerCapture(down.pointerId);
    item.classList.add("is-dragging");
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  });
};

/** Enhance every sortable list on the page. */
export const initSortable = (): void => {
  forEachMatch<HTMLElement>("[data-sortable]", (list) => {
    for (const handle of list.querySelectorAll<HTMLElement>(
      "[data-sortable-handle]",
    )) {
      setUpHandle(list, handle);
    }
  });
};
