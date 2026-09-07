import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { groupPackageRows } from "#shared/package-rows.ts";

type Row = { groupId: number; name: string };

const rowsOf = (rows: readonly [number, string][]): Row[] =>
  rows.map(([groupId, name]) => ({ groupId, name }));

describe("groupPackageRows", () => {
  test("keeps rows whose group does not collapse standing alone", () => {
    const rows = rowsOf([
      [0, "plain"],
      [0, "other plain"],
    ]);

    const groups = groupPackageRows(
      rows,
      (row) => row.groupId,
      () => false,
    );

    expect(groups).toEqual([{ rows: [rows[0]] }, { rows: [rows[1]] }]);
  });

  test("gathers a collapsed package at its first row's position", () => {
    const rows = rowsOf([
      [0, "before"],
      [7, "member one"],
      [0, "between"],
      [7, "member two"],
      [0, "after"],
    ]);

    const groups = groupPackageRows(
      rows,
      (row) => row.groupId,
      (groupId) => groupId !== 0,
    );

    expect(groups.map((group) => group.rows.map((row) => row.name))).toEqual([
      ["before"],
      ["member one", "member two"],
      ["between"],
      ["after"],
    ]);
    expect(groups[1]!.groupId).toBe(7);
  });

  test("keeps two collapsed packages separate, each at its own first row", () => {
    const rows = rowsOf([
      [7, "box one"],
      [8, "kit one"],
      [7, "box two"],
      [8, "kit two"],
    ]);

    const groups = groupPackageRows(
      rows,
      (row) => row.groupId,
      (groupId) => groupId !== 0,
    );

    expect(groups.map((group) => group.rows.map((row) => row.name))).toEqual([
      ["box one", "box two"],
      ["kit one", "kit two"],
    ]);
  });

  test("answers an empty walk for no rows", () => {
    expect(
      groupPackageRows(
        [],
        (row: Row) => row.groupId,
        () => true,
      ),
    ).toEqual([]);
  });
});
