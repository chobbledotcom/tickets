import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { tableRowContaining } from "#test-utils/assertions.ts";

describe("tableRowContaining", () => {
  test("rejects a table row without a closing tag", () => {
    expect(() => tableRowContaining("<tr><td>Open", "Missing")).toThrow(
      'No table row containing "Missing" found',
    );
  });

  test("rejects complete rows that do not contain the text", () => {
    expect(() =>
      tableRowContaining("<tr><td>Other</td></tr>", "Missing"),
    ).toThrow('No table row containing "Missing" found');
  });
});
