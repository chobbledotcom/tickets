/**
 * Reading a list into its rows, each known by the link that names it. What a
 * row offers has to be read off that row alone, so these check the markup each
 * row comes back with is its own and nobody else's.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { rowsOnList } from "#test/specs/support/form-controls/reading.ts";

// jscpd:ignore-end

describe("reading a list into its rows", () => {
  const LIST = "/admin/settings/statuses";
  const INTO_ONE = new RegExp(`^${LIST}/(\\d+)$`);

  const PAGE = `
    <table>
      <tr><th>Name</th><th>Order</th></tr>
      <tr>
        <td><a href="${LIST}/7">Confirmed</a></td>
        <td><form action="${LIST}/7/move-down"><button>▼</button></form></td>
      </tr>
      <tr>
        <td><a href="${LIST}/9">Fish &amp; Chips</a></td>
        <td><span class="badge">Paid</span></td>
      </tr>
    </table>
  `;

  test("finds each row by the link that names it, in the order shown", () => {
    expect(
      rowsOnList(PAGE, INTO_ONE).map(({ id, name, wayIn }) => ({
        id,
        name,
        wayIn,
      })),
    ).toEqual([
      { id: 7, name: "Confirmed", wayIn: `${LIST}/7` },
      { id: 9, name: "Fish & Chips", wayIn: `${LIST}/9` },
    ]);
  });

  test("hands each row its own markup and nothing of its neighbours'", () => {
    const [confirmed, fish] = rowsOnList(PAGE, INTO_ONE);
    expect(confirmed!.row).toContain("move-down");
    expect(confirmed!.row).not.toContain("badge");
    expect(fish!.row).toContain("badge");
    expect(fish!.row).not.toContain("move-down");
  });

  test("does not read markup after the table as the last row's", () => {
    // The last row's markup ends at its own closing tag — an arrow rendered
    // after the table must not read as an arrow on that row.
    const page = `
      <table>
        <tr><td><a href="${LIST}/7">Confirmed</a></td></tr>
      </table>
      <form action="${LIST}/7/move-up"><button>▲</button></form>
    `;
    expect(rowsOnList(page, INTO_ONE)[0]!.row).not.toContain("move-up");
  });

  test("keeps a final row the page never closes, as a browser would", () => {
    // HTML lets a table's last row omit its closing tag — the row then runs
    // to the end of what was written, and its link still names it.
    const page = `<table><tr><td><a href="${LIST}/5">Open ended</a></td>`;
    expect(rowsOnList(page, INTO_ONE)).toEqual([
      {
        id: 5,
        name: "Open ended",
        row: `><td><a href="${LIST}/5">Open ended</a></td>`,
        wayIn: `${LIST}/5`,
      },
    ]);
  });

  test("does not count a row whose link goes somewhere else", () => {
    const page = `
      <tr><td><a href="/admin/somewhere-else/3">Not one of these</a></td></tr>
      <tr><td><a href="${LIST}/3/edit">Deeper than a way in</a></td></tr>
    `;
    expect(rowsOnList(page, INTO_ONE)).toEqual([]);
  });

  test("reads the name the way the page spells it, markup and all", () => {
    const page = `<tr><td><a href="${LIST}/4"> <em>Spaced</em> out </a></td></tr>`;
    expect(rowsOnList(page, INTO_ONE)[0]!.name).toBe("Spaced out");
  });
});
