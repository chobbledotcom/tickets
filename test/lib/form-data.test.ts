import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#lib/form-data.ts";

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
