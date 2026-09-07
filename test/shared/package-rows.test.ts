import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { groupPackageRows } from "#shared/package-rows.ts";

type Row = { groupId: number; name: string };

const rowsOf = (rows: readonly [number, string][]): Row[] =>
  rows.map(([groupId, name]) => ({ groupId, name }));

/** Walks rows through the real helper and keeps each group's row names. */
const groupedNames =
  (collapses: (groupId: number) => boolean) =>
  (rows: readonly Row[]): string[][] =>
    groupPackageRows(rows, (row) => row.groupId, collapses).map((group) =>
      group.rows.map((row) => row.name),
    );

describe("groupPackageRows", () => {
  test("keeps rows whose group does not collapse standing alone", () => {
    const walk = groupedNames(() => false);

    expect(
      walk(
        rowsOf([
          [0, "plain"],
          [0, "other plain"],
        ]),
      ),
    ).toEqual([["plain"], ["other plain"]]);
  });

  test("gathers a collapsed package at its first row's position", () => {
    const walk = groupedNames((groupId) => groupId !== 0);
    const groups = groupPackageRows(
      rowsOf([
        [0, "before"],
        [7, "member one"],
        [0, "between"],
        [7, "member two"],
        [0, "after"],
      ]),
      (row) => row.groupId,
      (groupId) => groupId !== 0,
    );

    expect(
      walk(
        rowsOf([
          [0, "before"],
          [7, "member one"],
          [0, "between"],
          [7, "member two"],
          [0, "after"],
        ]),
      ),
    ).toEqual([
      ["before"],
      ["member one", "member two"],
      ["between"],
      ["after"],
    ]);
    expect(groups[1]!.groupId).toBe(7);
  });

  test("keeps two collapsed packages separate, each at its own first row", () => {
    expect(
      groupedNames((groupId) => groupId !== 0)(
        rowsOf([
          [7, "box one"],
          [8, "kit one"],
          [7, "box two"],
          [8, "kit two"],
        ]),
      ),
    ).toEqual([
      ["box one", "box two"],
      ["kit one", "kit two"],
    ]);
  });

  test("answers an empty walk for no rows", () => {
    expect(groupedNames(() => true)([])).toEqual([]);
  });
});
