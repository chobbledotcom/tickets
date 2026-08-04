/**
 * Moving one named row: the arrow has to sit on that row's own markup. An
 * arrow posting the right address from some other row is one the person
 * looking at this row does not have, so it must not count.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { OpensAtOneRow } from "#test/specs/support/browser.ts";
import {
  type Direction,
  movingRowsOn,
} from "#test/specs/support/reordering.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { recordingBrowser } from "#test-utils/test-browser/helpers.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

describe("finding a row's own arrow", () => {
  const LIST = "/admin/settings/statuses";
  const world = {} as TicketsWorld;

  /** A list open at the named row: the page holds every row given, and the
   * matched row is only ever the one carrying the name. */
  const listOpenAt =
    (rows: Record<string, { id: number; row: string }>): OpensAtOneRow =>
    (_world, name) => {
      const browser = new TestBrowser();
      browser.currentHtml = `<table>${Object.values(rows)
        .map(({ row }) => `<tr>${row}`)
        .join("")}</table>`;
      const found = rows[name]!;
      return Promise.resolve({
        browser,
        id: found.id,
        name,
        row: found.row,
        wayIn: `${LIST}/${found.id}`,
      });
    };

  const arrowAt = (id: number, direction: Direction = "up"): string =>
    `<td><form action="${LIST}/${id}/move-${direction}" method="POST"><button>➤</button></form></td>`;

  /** A list whose Confirmed row holds these cells beside its name, with any
   * other rows given alongside it. */
  const confirmedWith = (
    cells: string,
    others: Record<string, { id: number; row: string }> = {},
  ): Record<string, { id: number; row: string }> => ({
    Confirmed: { id: 7, row: `<td>Confirmed</td>${cells}` },
    ...others,
  });

  /** Whether the list of these rows offers to move Confirmed one way. */
  const offersConfirmed = (
    rows: Record<string, { id: number; row: string }>,
    direction: Direction = "up",
  ): Promise<boolean> =>
    movingRowsOn(LIST, listOpenAt(rows)).canMove(world, "Confirmed", direction);

  test("offers the arrow on the named row's own markup", async () => {
    expect(await offersConfirmed(confirmedWith(arrowAt(7)))).toBe(true);
  });

  test("does not offer an arrow rendered against somebody else's row", async () => {
    // The page carries this row's move-up address, but on the other row — the
    // person looking at Confirmed sees no arrow, so the story must not either.
    const rows = confirmedWith("<td></td>", {
      Paid: { id: 9, row: `<td>Paid</td>${arrowAt(7)}` },
    });
    expect(await offersConfirmed(rows)).toBe(false);
    await expect(
      movingRowsOn(LIST, listOpenAt(rows)).move(world, "Confirmed", "up"),
    ).rejects.toThrow('The list offers no way to move "Confirmed" up');
  });

  test("presses the row's own arrow, sending its form where it posts", async () => {
    const { browser, sent } = recordingBrowser();
    const row = `<td>Confirmed</td>${arrowAt(7)}`;
    browser.currentHtml = `<table><tr>${row}</table>`;
    const arrows = movingRowsOn(LIST, () =>
      Promise.resolve({
        browser,
        id: 7,
        name: "Confirmed",
        row,
        wayIn: `${LIST}/7`,
      }),
    );

    await arrows.move(world, "Confirmed", "up");

    expect(sent().method).toBe("POST");
    expect(sent().path).toBe(`${LIST}/7/move-up`);
  });

  test("does not read the other direction's arrow as this one's", async () => {
    const rows = confirmedWith(arrowAt(7, "down"));
    expect(await offersConfirmed(rows, "up")).toBe(false);
    expect(await offersConfirmed(rows, "down")).toBe(true);
  });
});
