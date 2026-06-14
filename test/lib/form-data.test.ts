import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";

describe("FormParams.getString", () => {
  test("returns the trimmed value when the key is present", () => {
    const form = new FormParams({ name: "  Alice  " });
    expect(form.getString("name")).toBe("Alice");
  });

  test("returns empty string when the key is absent", () => {
    const form = new FormParams();
    expect(form.getString("missing")).toBe("");
  });

  test("returns empty string when the value is empty", () => {
    const form = new FormParams({ name: "" });
    expect(form.getString("name")).toBe("");
  });

  test("returns empty string when the value is whitespace only", () => {
    const form = new FormParams({ name: "   " });
    expect(form.getString("name")).toBe("");
  });
});

describe("FormParams.getNumberArray", () => {
  test("parses all repeated values as integers", () => {
    const form = new FormParams();
    form.append("ids", "1");
    form.append("ids", "2");
    form.append("ids", "3");
    expect(form.getNumberArray("ids")).toEqual([1, 2, 3]);
  });

  test("drops values that are not numbers", () => {
    const form = new FormParams();
    form.append("ids", "1");
    form.append("ids", "abc");
    form.append("ids", "4");
    expect(form.getNumberArray("ids")).toEqual([1, 4]);
  });

  test("returns empty array when the key is absent", () => {
    const form = new FormParams();
    expect(form.getNumberArray("ids")).toEqual([]);
  });
});
