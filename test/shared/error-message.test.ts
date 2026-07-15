import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { errorMessage } from "#shared/error-message.ts";

describe("errorMessage", () => {
  test("reads the message from an Error", () => {
    expect(errorMessage(new Error("broke"))).toBe("broke");
  });

  test("converts non-Error values to strings", () => {
    expect(errorMessage("string")).toBe("string");
    expect(errorMessage(null)).toBe("null");
  });
});
