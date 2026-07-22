import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  isCompactWidth,
  isolateElementCss,
  wasImageTrimmed,
} from "#scripts/screenshots/checks.ts";

describe("screenshot checks", () => {
  it("accepts a money table that uses no more than three quarters of its section", () => {
    expect(isCompactWidth(750, 1000)).toBe(true);
  });

  it("rejects a money table that fills its section", () => {
    expect(isCompactWidth(1000, 1000)).toBe(false);
  });

  it("keeps every selected element and its descendants visible", () => {
    expect(isolateElementCss("form, aside")).toBe(
      `body * { visibility: hidden !important; }
:is(form, aside), :is(form, aside) * { visibility: visible !important; }`,
    );
  });

  it("accepts a full-width image that was trimmed vertically", () => {
    expect(
      wasImageTrimmed(
        { height: 1000, width: 780 },
        { height: 864, width: 844 },
        32,
      ),
    ).toBe(true);
  });

  it("rejects an image with no trimmed background", () => {
    expect(
      wasImageTrimmed(
        { height: 1000, width: 780 },
        { height: 1064, width: 844 },
        32,
      ),
    ).toBe(false);
  });
});
