/**
 * Drag to reorder, on a real admin page: the statuses list as the app serves
 * it. A drag runs in the page, and the drop is sent to the app the way the
 * browser sends the form, so the stored order proves the whole path.
 */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { initSortable } from "#src/ui/client/admin/sortable.ts";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDomInstaller,
  fireEvent,
  requireElement,
  requireElements,
} from "#test-utils/happy-dom.ts";

const LIST = "/admin/settings/statuses";

/** The status ids in the order the list shows them, read off the handles. */
const shownIds = (html: string): string[] =>
  [...html.matchAll(/data-sortable-anchor="(\d+)"/g)].map((match) => match[1]!);

/** A logged-in owner with three statuses: the first status, then two more. */
const openStatuses = async (): Promise<App> => {
  const app = createApp(inProcess);
  await app.logIn();
  await app.submit(`${LIST}/new`, { name: "Second" }, LIST);
  await app.submit(`${LIST}/new`, { name: "Third" }, LIST);
  return app;
};

/** One drag: the row picked up, then each pointer event after the press, as
 *  a type and the height the pointer is at. A height above the list is over
 *  the table head. */
type Drag = {
  row: number;
  steps: readonly (readonly [string, number?])[];
  button?: number;
};

/** The list page in the browser, with the drag script running. Every row
 *  reports a 20px band, stacked from the top. Each form the page submits is
 *  recorded, not sent. */
const inBrowser = (
  dom: ReturnType<typeof createDomInstaller>,
  html: string,
) => {
  const window = dom.installDom(html);
  const { document } = window;
  const rows = requireElements<HTMLElement>(
    document,
    "tbody[data-sortable] > tr",
  );
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () =>
      ({ height: 20, top: index * 20 }) as DOMRect;
  });
  const header = requireElement<HTMLElement>(document, "thead th");
  const underPointer = (_x: number, y: number): Element | null =>
    y < 0
      ? header
      : (rows.find((_row, index) => y >= index * 20 && y < index * 20 + 20)
          ?.firstElementChild ?? null);
  Object.defineProperty(document, "elementFromPoint", { value: underPointer });
  const sent: { action: string; fields: Record<string, string> }[] = [];
  window.HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    sent.push({
      action: new URL(this.action).pathname,
      fields: Object.fromEntries(
        [...this.querySelectorAll("input")].map((input) => [
          input.name,
          input.value,
        ]),
      ),
    });
  };
  initSortable();
  const drag = ({ row, steps, button = 0 }: Drag): void => {
    const handle = requireElement<HTMLElement>(
      rows[row]!,
      "[data-sortable-handle]",
    );
    handle.setPointerCapture = () => {};
    const pointer = (type: string, clientY?: number, pressed = 0): void => {
      fireEvent(
        handle,
        new window.PointerEvent(type, {
          bubbles: true,
          button: pressed,
          pointerId: 1,
          ...(clientY === undefined ? {} : { clientY }),
        }),
      );
    };
    pointer("pointerdown", undefined, button);
    for (const [type, clientY] of steps) pointer(type, clientY);
  };
  const ids = (): string[] => shownIds(document.body.innerHTML);
  return { document, drag, ids, rows, sent };
};

describeWithEnv("drag to reorder", { db: true }, () => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());

  for (const [title, drag, order] of [
    [
      "a drop at the top stores the row first",
      { row: 2, steps: [["pointermove", 5], ["pointerup"]] },
      [2, 0, 1],
    ],
    [
      "a drop lower down stores the row after the one now above it",
      { row: 0, steps: [["pointermove", 35], ["pointerup"]] },
      [1, 0, 2],
    ],
  ] as const) {
    test(title, async () => {
      const app = await openStatuses();
      const page = inBrowser(dom, (await app.get(LIST)).html);
      const before = page.ids();

      page.drag(drag);
      const { action, fields } = page.sent[0]!;
      const stored = await app.submit(LIST, fields, action);

      expect(stored.status).toBe(302);
      expect(shownIds((await app.get(LIST)).html)).toEqual(
        order.map((index) => before[index]),
      );
    });
  }

  for (const [title, drag] of [
    [
      "a cancelled drag",
      { row: 0, steps: [["pointermove", 45], ["pointercancel"]] },
    ],
    [
      "a release in the same place",
      {
        row: 1,
        steps: [["pointermove", 25], ["pointermove", 500], ["pointerup"]],
      },
    ],
    [
      "a pointer over the table head",
      { row: 2, steps: [["pointermove", -10], ["pointerup"]] },
    ],
    [
      "a move after the drag ended",
      { row: 1, steps: [["pointercancel"], ["pointermove", 5]] },
    ],
    [
      "a press with another button",
      { button: 2, row: 0, steps: [["pointermove", 45]] },
    ],
  ] as const) {
    test(`${title} keeps the rows and sends nothing`, async () => {
      const page = inBrowser(
        dom,
        (await (await openStatuses()).get(LIST)).html,
      );
      const before = page.ids();

      page.drag(drag);

      expect({ ids: page.ids(), sent: page.sent }).toEqual({
        ids: before,
        sent: [],
      });
    });
  }

  test("the drop sends every field the row's arrow form carries", async () => {
    const page = inBrowser(dom, (await (await openStatuses()).get(LIST)).html);
    const arrow = requireElement<HTMLFormElement>(page.rows[2]!, "form");
    const carried = Object.fromEntries(
      [...arrow.querySelectorAll("input")].map((input) => [
        input.name,
        input.value,
      ]),
    );

    page.drag({ row: 2, steps: [["pointermove", 5], ["pointerup"]] });

    expect(page.sent[0]!.fields).toEqual({ ...carried, anchor: page.ids()[1] });
  });

  test("shows the handles and marks the row while it is dragged", async () => {
    const page = inBrowser(dom, (await (await openStatuses()).get(LIST)).html);
    const handles = requireElements<HTMLElement>(
      page.document,
      "[data-sortable-handle]",
    );

    page.drag({ row: 1, steps: [] });

    expect({
      dragging: page.rows[1]!.classList.contains("is-dragging"),
      hidden: handles.map((handle) => handle.hidden),
    }).toEqual({ dragging: true, hidden: [false, false, false] });
  });
});
