/**
 * Drag to reorder, on a real admin page: the statuses list as the app serves
 * it. A drag runs in the page, and the drop is sent to the app the way the
 * browser sends the form, so the stored order proves the whole path.
 */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import { fieldsOf, openSortablePage } from "#test/blackbox/sortable-page.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDomInstaller,
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

/** The statuses page in the browser, with the drag script running. */
const inBrowser = (
  dom: ReturnType<typeof createDomInstaller>,
  html: string,
) => {
  const page = openSortablePage(dom, html, {
    selector: "tbody[data-sortable]",
  });
  return {
    ...page,
    ids: (): string[] => shownIds(page.document.body.innerHTML),
    rows: page.items,
  };
};

describeWithEnv("drag to reorder", { db: true }, () => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());

  for (const [title, drag, order] of [
    [
      "a drop at the top stores the row first",
      { item: 2, steps: [["pointermove", 5], ["pointerup"]] },
      [2, 0, 1],
    ],
    [
      "a drop lower down stores the row after the one now above it",
      { item: 0, steps: [["pointermove", 35], ["pointerup"]] },
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
      { item: 0, steps: [["pointermove", 45], ["pointercancel"]] },
    ],
    [
      "a release in the same place",
      {
        item: 1,
        steps: [["pointermove", 25], ["pointermove", 500], ["pointerup"]],
      },
    ],
    [
      "a pointer off the list",
      { item: 2, steps: [["pointermove", -10], ["pointerup"]] },
    ],
    [
      "a move after the drag ended",
      { item: 1, steps: [["pointercancel"], ["pointermove", 5]] },
    ],
    [
      "a press with another button",
      { button: 2, item: 0, steps: [["pointermove", 45]] },
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

  test("the drop sends every field the row's arrow form carries, and the page to come back to", async () => {
    const page = inBrowser(dom, (await (await openStatuses()).get(LIST)).html);
    window.history.replaceState(null, "", `${LIST}?shown=all`);
    const arrow = requireElement<HTMLFormElement>(page.rows[2]!, "form");
    const carried = fieldsOf(arrow);

    page.drag({ item: 2, steps: [["pointermove", 5], ["pointerup"]] });

    expect(page.sent[0]!.fields).toEqual({
      ...carried,
      anchor: page.ids()[1],
      returnUrl: `${LIST}?shown=all`,
    });
  });

  test("shows the handles and marks the row while it is dragged", async () => {
    const page = inBrowser(dom, (await (await openStatuses()).get(LIST)).html);
    const handles = requireElements<HTMLElement>(
      page.document,
      "[data-sortable-handle]",
    );

    page.drag({ item: 1, steps: [] });

    expect({
      dragging: page.rows[1]!.classList.contains("is-dragging"),
      hidden: handles.map((handle) => handle.hidden),
    }).toEqual({ dragging: true, hidden: [false, false, false] });
  });
});
