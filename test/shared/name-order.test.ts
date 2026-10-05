/** Sorting named records: the admin tables and storage listings render in this
 * order, so pin the comparator's contract once. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sortByName } from "#shared/name-order.ts";

describe("sortByName", () => {
  test("orders named records by name in ascending locale order", () => {
    expect(
      sortByName([{ name: "b" }, { name: "A" }, { name: "c" }]).map(
        (row) => row.name,
      ),
    ).toEqual(["A", "b", "c"]);
  });

  test("leaves the input array unchanged", () => {
    const rows = [{ name: "b" }, { name: "a" }];
    sortByName(rows);
    expect(rows.map((row) => row.name)).toEqual(["b", "a"]);
  });

  test("orders no records into an empty array", () => {
    expect(sortByName([])).toEqual([]);
  });
});
