/**
 * A page the app served, opened in happy-dom with the drag script running.
 * Each item of the sortable list reports a 20px band: stacked from the top in
 * a list, side by side in a grid. A position below 0 is off the list. Each
 * form the page submits is recorded, not sent.
 */

import { initSortable } from "#src/ui/client/admin/sortable.ts";
import {
  type createDomInstaller,
  fireEvent,
  requireElement,
  requireElements,
} from "#test-utils/happy-dom.ts";

/** One drag: the item picked up, then each pointer event after the press, as
 *  a type and the position the pointer is at along the list. */
export type Drag = {
  item: number;
  steps: readonly (readonly [string, number?])[];
  button?: number;
};

/** One form the page submitted: where to, and its fields. */
export type SentForm = { action: string; fields: Record<string, string> };

const BAND = 20;

/** The fields one form sends. */
export const fieldsOf = (form: Element): Record<string, string> =>
  Object.fromEntries(
    [...form.querySelectorAll("input")].map((input) => [
      input.name,
      input.value,
    ]),
  );

export const openSortablePage = (
  dom: ReturnType<typeof createDomInstaller>,
  html: string,
  list: { selector: string; across?: boolean },
) => {
  const window = dom.installDom(html);
  const { document } = window;
  const items = requireElements<HTMLElement>(document, `${list.selector} > *`);
  const axis = list.across ? "clientX" : "clientY";
  items.forEach((item, index) => {
    const start = index * BAND;
    item.getBoundingClientRect = () =>
      (list.across
        ? { height: BAND, left: start, top: 0, width: BAND }
        : { height: BAND, left: 0, top: start, width: BAND }) as DOMRect;
  });
  const offList = requireElement<HTMLElement>(document, "main");
  const underPointer = (x: number, y: number): Element | null => {
    const position = list.across ? x : y;
    if (position < 0) return offList;
    return items[Math.floor(position / BAND)]?.firstElementChild ?? null;
  };
  Object.defineProperty(document, "elementFromPoint", { value: underPointer });
  const sent: SentForm[] = [];
  window.HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    sent.push({
      action: new URL(this.action).pathname,
      fields: fieldsOf(this),
    });
  };
  initSortable();
  const drag = ({ item, steps, button = 0 }: Drag): void => {
    const handle = requireElement<HTMLElement>(
      items[item]!,
      "[data-sortable-handle]",
    );
    handle.setPointerCapture = () => {};
    const pointer = (type: string, position?: number, pressed = 0): void => {
      fireEvent(
        handle,
        new window.PointerEvent(type, {
          bubbles: true,
          button: pressed,
          pointerId: 1,
          ...(position === undefined ? {} : { [axis]: position }),
        }),
      );
    };
    pointer("pointerdown", undefined, button);
    for (const [type, position] of steps) pointer(type, position);
  };
  return { document, drag, items, sent, window };
};
