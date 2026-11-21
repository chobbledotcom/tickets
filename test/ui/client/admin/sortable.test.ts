import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { defineTable } from "#shared/tables/definition.ts";
import { initSortable } from "#src/ui/client/admin/sortable.ts";
import { renderTable } from "#templates/components/table.tsx";
import {
  createDomInstaller,
  fireEvent,
  requireElement,
  requireElements,
} from "#test-utils/happy-dom.ts";

type Thing = { id: number; name: string };

/** Three rows of a reorderable table, as the admin page renders them. */
const tableHtml = (): string =>
  String(
    renderTable(
      defineTable<Thing>([
        { cell: (row) => row.name, header: "Name", key: "name" },
      ]),
      [
        { id: 1, name: "One" },
        { id: 2, name: "Two" },
        { id: 3, name: "Three" },
      ],
      {
        reorder: {
          anchor: (row) => String(row.id),
          header: "Order",
          path: (row) => `/admin/things/${row.id}`,
        },
      },
    ),
  );

describe("sortable lists", () => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());

  /** The table with the drag script wired. Every row reports a 20px band
   *  stacked from the top, and the pointer lands on the row whose band holds
   *  it. Each submitted move form is recorded. */
  const setUp = () => {
    const window = dom.installDom(tableHtml());
    const { document } = window;
    const rows = requireElements<HTMLElement>(document, "tbody tr");
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () =>
        ({ height: 20, top: index * 20 }) as DOMRect;
    });
    const submitted: { action: string; fields: Record<string, string> }[] = [];
    window.HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      submitted.push({
        action: new URL(this.action).pathname,
        fields: Object.fromEntries(
          [...this.querySelectorAll("input")].map((input) => [
            input.name,
            input.value,
          ]),
        ),
      });
    };
    const header = requireElement<HTMLElement>(document, "thead th");
    const atHeight = (_x: number, y: number): Element | null =>
      y < 0
        ? header
        : (rows.find((row) => {
            const box = row.getBoundingClientRect();
            return y >= box.top && y < box.top + box.height;
          })?.firstElementChild ?? null);
    document.elementFromPoint =
      atHeight as unknown as typeof document.elementFromPoint;
    initSortable();
    const handleOf = (row: HTMLElement): HTMLElement => {
      const handle = requireElement<HTMLElement>(row, "[data-sortable-handle]");
      handle.setPointerCapture = () => {};
      return handle;
    };
    const pointer = (
      target: HTMLElement,
      type: string,
      init: { button?: number; clientY?: number } = {},
    ): void => {
      fireEvent(
        target,
        new window.PointerEvent(type, {
          bubbles: true,
          button: 0,
          pointerId: 1,
          ...init,
        }),
      );
    };
    const names = (): string[] =>
      requireElements<HTMLElement>(document, "tbody tr").map(
        (row) => row.lastElementChild!.textContent!,
      );
    return { document, handleOf, names, pointer, rows, submitted };
  };

  test("shows each handle once the script runs", () => {
    const { document } = setUp();

    expect(
      requireElements<HTMLElement>(document, "[data-sortable-handle]").map(
        (handle) => handle.hidden,
      ),
    ).toEqual([false, false, false]);
  });

  /** One drag: the row index picked up, then each pointer event after the
   *  press, as a type and the height the pointer is at. */
  type Drag = {
    row: number;
    steps: readonly (readonly [string, number?])[];
  };

  /** Run one drag, then hand back the row names and each posted move. */
  const dragged = ({ row, steps }: Drag) => {
    const { handleOf, names, pointer, rows, submitted } = setUp();
    const handle = handleOf(rows[row]!);
    pointer(handle, "pointerdown");
    for (const [type, clientY] of steps) {
      pointer(handle, type, clientY === undefined ? {} : { clientY });
    }
    return {
      names: names(),
      posts: submitted.map(({ action, fields }) => [action, fields.anchor]),
    };
  };

  const STILL = ["One", "Two", "Three"];

  for (const [title, drag, names, posts] of [
    [
      "a drop at the top posts a move before the row now below",
      { row: 2, steps: [["pointermove", 5], ["pointerup"]] },
      ["Three", "One", "Two"],
      [["/admin/things/3/move-before", "1"]],
    ],
    [
      "a drop lower down posts a move after the row now above",
      { row: 0, steps: [["pointermove", 35], ["pointerup"]] },
      ["Two", "One", "Three"],
      [["/admin/things/1/move-after", "2"]],
    ],
    [
      "a cancelled drag puts the row back and posts nothing",
      { row: 0, steps: [["pointermove", 45], ["pointercancel"]] },
      STILL,
      [],
    ],
    [
      "a release in the same place posts nothing",
      {
        row: 1,
        steps: [["pointermove", 25], ["pointermove", 500], ["pointerup"]],
      },
      STILL,
      [],
    ],
    [
      "a pointer outside the list leaves the row where it is",
      { row: 2, steps: [["pointermove", -10]] },
      STILL,
      [],
    ],
    [
      "a finished drag stops following the pointer",
      { row: 1, steps: [["pointercancel"], ["pointermove", 5]] },
      STILL,
      [],
    ],
  ] as const) {
    test(title, () => {
      expect(dragged(drag)).toEqual({ names, posts });
    });
  }

  test("posts the CSRF token and the page to come back to", () => {
    const { document, handleOf, pointer, rows, submitted } = setUp();
    window.history.replaceState(null, "", "/admin/listings?group=4");
    const handle = handleOf(rows[1]!);

    pointer(handle, "pointerdown");
    pointer(handle, "pointermove", { clientY: 5 });
    pointer(handle, "pointerup");

    expect(submitted[0]!.fields).toEqual({
      anchor: "1",
      csrfToken: requireElement<HTMLInputElement>(
        document,
        'input[name="csrfToken"]',
      ).value,
      returnUrl: "/admin/listings?group=4",
    });
  });

  test("marks the row while it is dragged", () => {
    const { handleOf, pointer, rows } = setUp();
    const handle = handleOf(rows[1]!);

    pointer(handle, "pointerdown");
    expect(rows[1]!.classList.contains("is-dragging")).toBe(true);
    pointer(handle, "pointerup");

    expect(rows[1]!.classList.contains("is-dragging")).toBe(false);
  });

  test("ignores a press with another button", () => {
    const { handleOf, pointer, rows } = setUp();

    pointer(handleOf(rows[0]!), "pointerdown", { button: 2 });

    expect(rows[0]!.classList.contains("is-dragging")).toBe(false);
  });
});
