import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getString } from "#lib/form-data.ts";

describe("getString", () => {
  test("returns the trimmed value when the key is present", () => {
    const form = new URLSearchParams({ name: "  Alice  " });
    expect(getString(form, "name")).toBe("Alice");
  });

  test("returns empty string when the key is absent", () => {
    const form = new URLSearchParams();
    expect(getString(form, "missing")).toBe("");
  });

  test("returns empty string when the value is empty", () => {
    const form = new URLSearchParams({ name: "" });
    expect(getString(form, "name")).toBe("");
  });

  test("returns empty string when the value is whitespace only", () => {
    const form = new URLSearchParams({ name: "   " });
    expect(getString(form, "name")).toBe("");
  });
});
