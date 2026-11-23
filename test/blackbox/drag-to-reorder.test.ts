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

    const posted = requireElement<HTMLFormElement>(
      page.document,
      "body > form:last-child",
    );
    expect({
      fields: page.sent[0]!.fields,
      posted: [posted.tagName, posted.hidden],
    }).toEqual({
      fields: {
        ...carried,
        anchor: page.ids()[1],
        returnUrl: `${LIST}?shown=all`,
      },
      posted: ["FORM", true],
    });
  });

  test("a drop ends the drag, so a later release or cancel changes nothing", async () => {
    const page = inBrowser(dom, (await (await openStatuses()).get(LIST)).html);
    const before = page.ids();

    page.drag({
      item: 2,
      steps: [
        ["pointermove", 5],
        ["pointerup"],
        ["pointerup"],
        ["pointercancel"],
      ],
    });

    expect({
      dragging: page.rows[2]!.classList.contains("is-dragging"),
      ids: page.ids(),
      sent: page.sent.length,
    }).toEqual({
      dragging: false,
      ids: [before[2], before[0], before[1]],
      sent: 1,
    });
  });

  test("marks the list ready, which shows the handles in place of the arrows, and marks the row while it is dragged", async () => {
    const page = inBrowser(dom, (await (await openStatuses()).get(LIST)).html);

    page.drag({ item: 1, steps: [] });

    expect({
      dragging: page.rows[1]!.classList.contains("is-dragging"),
      ready: requireElement<HTMLElement>(page.document, "tbody[data-sortable]")
        .dataset.sortableReady,
    }).toEqual({ dragging: true, ready: "" });
  });

  test("a press on the handle starts a drag and stops the browser's own action, and a press beside it does neither", async () => {
    const page = inBrowser(dom, (await (await openStatuses()).get(LIST)).html);
    const row = page.rows[1]!;
    const handle = requireElement<HTMLElement>(row, "[data-sortable-handle]");
    const cell = requireElements<HTMLElement>(row, "td").find(
      (each) => each.querySelector("[data-sortable-handle]") === null,
    )!;
    const press = (target: HTMLElement) => {
      const down = new page.window.PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
      });
      fireEvent(target, down);
      return [down.defaultPrevented, row.classList.contains("is-dragging")];
    };

    expect([press(cell), press(handle)]).toEqual([
      [false, false],
      [true, true],
    ]);
  });
});
