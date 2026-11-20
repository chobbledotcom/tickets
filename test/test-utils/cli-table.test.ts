import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseOrUsage } from "#test-utils/cli-table.ts";

describe("parseOrUsage", () => {
  test("answers a usage error's exit code and message", () => {
    expect(parseOrUsage(["get", "gadgets"])).toEqual({
      code: 2,
      message: "The 'get' command needs the gadget id.",
    });
  });

  test("throws when the command parses, so a test cannot pass by accident", () => {
    expect(() => parseOrUsage(["list", "gadgets"])).toThrow(
      "expected a usage error for list gadgets",
    );
  });
});
