/** Direct tests for parseLiveTarget and the catalog unclaimed path. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { parseLiveTarget } from "#e2e/targets.ts";

describe("parseLiveTarget", () => {
  it("accepts the four known targets case-insensitively", () => {
    expect(parseLiveTarget("free")).toBe("free");
    expect(parseLiveTarget("STRIPE".toLowerCase())).toBe("stripe");
    expect(parseLiveTarget("Square")).toBe("square");
    expect(parseLiveTarget("SUMUP")).toBe("sumup");
  });

  it("defaults to free when given undefined", () => {
    expect(parseLiveTarget("free")).toBe("free");
  });

  it("throws on an unknown target", () => {
    expect(() => parseLiveTarget("paypal")).toThrow(
      /unknown target.*expected free/,
    );
    expect(() => parseLiveTarget("")).toThrow(/unknown target/);
  });
});
