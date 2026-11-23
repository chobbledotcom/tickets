// effects: pure
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Drag to reorder any list marked `data-sortable`. A drag starts on an
 * item's `data-sortable-handle`, and moves the item in the page. A list
 * marked `data-sortable-drop="local"` keeps the new order in the page, and
 * tells its own script with a `SORTABLE_MOVED` event. Any other list posts
 * the drop as the same move that the arrows post. It names the item now
 * above, or the item now below. The server stores the order, and the page
 * reloads with it. Pointer Events cover the mouse, touch, and pen.
 */

import type { MovePlace } from "#shared/reorder.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  createHiddenInput,
  forEachMatch,
  requiredChild,
} from "#src/ui/client/dom.ts";

/** The event a `local` list sends after a drop changes its order. */
export const SORTABLE_MOVED = "sortable-moved";

/** The direct child of `list` that holds `node`. Null when the node is not
 *  inside an item, such as the gap between two cards. */
const itemHoldingOrNull = (
  list: HTMLElement,
  node: Element,
): HTMLElement | null =>
  ([...list.children].find((child) => child.contains(node)) as
    | HTMLElement
    | undefined) ?? null;

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
  if (node === null || dragged.contains(node)) return null;
  return itemHoldingOrNull(list, node);
};

/** Put the dragged item before or after the item under the pointer. The half
 *  of that item the pointer is over decides. A list compares the upper and
 *  lower halves. A `grid` of cards that wraps compares the left and right. */
const moveBeside = (
  list: HTMLElement,
  dragged: HTMLElement,
  event: PointerEvent,
): void => {
  const over = itemUnderPointer(list, dragged, event);
  if (over === null) return;
  const box = over.getBoundingClientRect();
  const firstHalf =
    list.dataset.sortable === "grid"
      ? event.clientX < box.left + box.width / 2
      : event.clientY < box.top + box.height / 2;
  list.insertBefore(dragged, firstHalf ? over : over.nextElementSibling);
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

/** Post a copy of the arrow form of the item, so the drop sends the same
 *  fields an arrow sends. Only the address and the anchor change. The server
 *  sends the operator back to this page, with its filters. */
const postMove = (item: HTMLElement): void => {
  const move = moveFor(item);
  const path = requireValue(handleOf(item).dataset.sortablePath, "path");
  const form = requiredChild<HTMLFormElement>(item, "form").cloneNode(
    true,
  ) as HTMLFormElement;
  form.action = `${path}/move-${move.place}`;
  form.querySelector('input[name="anchor"]')?.remove();
  form.append(
    createHiddenInput("anchor", move.anchor),
    createHiddenInput(
      "returnUrl",
      window.location.pathname + window.location.search,
    ),
  );
  form.hidden = true;
  document.body.append(form);
  form.submit();
};

/** Where a list keeps a dropped order: on the server, or in the page. */
type DropMode = "local" | "post";

const DROP: Record<DropMode, (list: HTMLElement, item: HTMLElement) => void> = {
  local: (list) => list.dispatchEvent(new Event(SORTABLE_MOVED)),
  post: (_list, item) => postMove(item),
};

const dropModeOf = (list: HTMLElement): DropMode =>
  list.dataset.sortableDrop === "local" ? "local" : "post";

/** Pick up the item whose handle the press is on, and follow the pointer
 *  until it lets go. The document hears the pointer, because a move in the
 *  page takes the pointer away from the handle. A cancelled drag puts the
 *  item back. */
const startDrag = (list: HTMLElement, down: PointerEvent): void => {
  if (down.button !== 0) return;
  const path = down.composedPath();
  const handle = [
    ...list.querySelectorAll<HTMLElement>("[data-sortable-handle]"),
  ].find((each) => path.includes(each));
  if (handle === undefined) return;
  down.preventDefault();
  const item = requireValue(itemHoldingOrNull(list, handle), "sortable item");
  const before = item.nextElementSibling;
  const onMove = (event: PointerEvent): void => moveBeside(list, item, event);
  const onUp = (): void => finish(true);
  const onCancel = (): void => finish(false);
  const finish = (commit: boolean): void => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    item.classList.remove("is-dragging");
    if (item.nextElementSibling === before) return;
    if (commit) {
      DROP[dropModeOf(list)](list, item);
    } else {
      list.insertBefore(item, before);
    }
  };
  item.classList.add("is-dragging");
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
};

/** Enhance every sortable list on the page. The list hears each press, so a
 *  handle added later works too. `data-sortable-ready` shows the handles and
 *  hides the arrows, which are for a page without scripts. */
export const initSortable = (): void => {
  forEachMatch<HTMLElement>("[data-sortable]", (list) => {
    list.dataset.sortableReady = "";
    list.addEventListener("pointerdown", (down) => startDrag(list, down));
  });
};
