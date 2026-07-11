/**
 * Latitude/longitude pair validation: both-blank means no pin, both-valid
 * means a trimmed pin, and anything else fails.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseCoordinatePair } from "#shared/validation/coordinates.ts";

describe("parseCoordinatePair", () => {
  test("both blank is a valid empty pin", () => {
    expect(parseCoordinatePair("", "  ")).toEqual({
      ok: true,
      pin: { lat: "", lng: "" },
    });
  });

  test("a valid pair round-trips trimmed but otherwise as entered", () => {
    expect(parseCoordinatePair(" 57.147740 ", "-2.096323")).toEqual({
      ok: true,
      pin: { lat: "57.147740", lng: "-2.096323" },
    });
  });

  test("whole-degree values are valid", () => {
    expect(parseCoordinatePair("51", "0")).toEqual({
      ok: true,
      pin: { lat: "51", lng: "0" },
    });
  });

  test("the extreme corners of the world are valid", () => {
    expect(parseCoordinatePair("90", "-180").ok).toBe(true);
    expect(parseCoordinatePair("-90", "180").ok).toBe(true);
  });

  const invalid: [string, string, string][] = [
    ["latitude without longitude", "51.5", ""],
    ["longitude without latitude", "", "-0.1"],
    ["latitude past the pole", "90.001", "0"],
    ["longitude past the date line", "0", "180.001"],
    ["latitude far out of range", "91", "0"],
    ["a non-number", "north-ish", "0"],
    ["scientific notation", "1e2", "0"],
    ["a trailing letter", "51.5x", "0"],
    ["an inner space", "51 .5", "0"],
  ];
  for (const [label, lat, lng] of invalid) {
    test(`rejects ${label}`, () => {
      expect(parseCoordinatePair(lat, lng)).toEqual({ ok: false });
    });
  }
});
