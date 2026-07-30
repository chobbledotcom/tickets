import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { inputNamed, tableRowContaining } from "#test-utils/assertions.ts";

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

describe("inputNamed", () => {
  test("hands back the one input tag with the given name", () => {
    expect(inputNamed('<p><input id="a" name="a" required></p>', "a")).toBe(
      '<input id="a" name="a" required>',
    );
  });

  test("rejects a page with no control of that name", () => {
    expect(() => inputNamed("<p>No boxes here</p>", "a")).toThrow(
      "No control named a on the page",
    );
  });

  test("hands back a textarea or select with the given name too", () => {
    expect(inputNamed('<textarea name="notes" required>', "notes")).toBe(
      '<textarea name="notes" required>',
    );
    expect(inputNamed('<select name="kind">', "kind")).toBe(
      '<select name="kind">',
    );
  });
});
