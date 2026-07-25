import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { parseRgb } from "#scripts/screenshots/color.ts";

describe("screenshot colour", () => {
  it("reads the red, green, and blue parts of an rgb() string", () => {
    expect(parseRgb("rgb(255, 128, 64)")).toEqual({
      b: 64,
      g: 128,
      r: 255,
    });
  });

  it("ignores the alpha channel of an rgba() string", () => {
    expect(parseRgb("rgba(10, 20, 30, 0.5)")).toEqual({ b: 30, g: 20, r: 10 });
  });

  it("throws when the colour is not a number triple", () => {
    expect(() => parseRgb("transparent")).toThrow(
      "Could not read screenshot background colour: transparent",
    );
  });

  it("throws when the colour only has two channels", () => {
    expect(() => parseRgb("rgb(1, 2)")).toThrow(
      "Could not read screenshot background colour: rgb(1, 2)",
    );
  });
});
