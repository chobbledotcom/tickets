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

describe("FormParams.getOptionalInt", () => {
  test("parses trimmed non-negative decimal integers", () => {
    const form = new FormParams({ blank: "", count: " 12 ", zero: "0" });
    expect(form.getOptionalInt("count")).toBe(12);
    expect(form.getOptionalInt("zero")).toBe(0);
    expect(form.getOptionalInt("blank")).toBeNull();
  });

  test("rejects signs, fractions, exponents and trailing junk", () => {
    for (const value of ["+1", "-1", "1.5", "1e2", "1abc", "2x"]) {
      const form = new FormParams({ count: value });
      expect(form.getOptionalInt("count")).toBeNull();
    }
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

  test("drops values that are not strict positive decimal ids", () => {
    const form = new FormParams();
    form.append("ids", "1");
    form.append("ids", "abc");
    form.append("ids", "0");
    form.append("ids", "+2");
    form.append("ids", "2x");
    form.append("ids", "3.5");
    form.append("ids", "4e1");
    form.append("ids", "4");
    expect(form.getNumberArray("ids")).toEqual([1, 4]);
  });

  test("returns empty array when the key is absent", () => {
    const form = new FormParams();
    expect(form.getNumberArray("ids")).toEqual([]);
  });
});
