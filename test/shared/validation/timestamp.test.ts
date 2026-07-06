import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  epochMsToIso,
  instantToEpochMs,
  isInstant,
} from "#shared/validation/timestamp.ts";

describe("validation > timestamp", () => {
  describe("isInstant", () => {
    const accepted: [name: string, value: string][] = [
      ["canonical .sssZ", "2026-01-01T00:00:00.000Z"],
      ["millisecond precision", "2026-01-01T00:00:00.123Z"],
      ["no milliseconds", "2026-01-01T00:00:00Z"],
      ["numeric offset", "2026-01-01T01:00:00+01:00"],
    ];
    for (const [name, value] of accepted) {
      test(`accepts ${name}`, () => {
        expect(isInstant(value)).toBe(true);
      });
    }

    const rejected: [name: string, value: string][] = [
      [
        "sub-millisecond precision (cannot be stored)",
        "2026-01-01T00:00:00.123456789Z",
      ],
      ["an impossible day (Feb 30)", "2026-02-30T00:00:00Z"],
      ["an out-of-range month", "2026-13-01T00:00:00Z"],
      ["an out-of-range hour", "2026-01-01T24:00:00Z"],
      ["a non-ISO format", "21/06/2026"],
      ["an empty string", ""],
    ];
    for (const [name, value] of rejected) {
      test(`rejects ${name}`, () => {
        expect(isInstant(value)).toBe(false);
      });
    }
  });

  describe("instantToEpochMs", () => {
    test("returns epoch-millis for a canonical instant", () => {
      expect(instantToEpochMs("2026-01-01T00:00:00.000Z")).toBe(1767225600000);
    });

    test("resolves an offset to the same instant as its UTC form", () => {
      expect(instantToEpochMs("2026-01-01T01:00:00+01:00")).toBe(
        instantToEpochMs("2026-01-01T00:00:00Z"),
      );
    });
  });

  describe("epochMsToIso", () => {
    test("formats epoch-millis as the canonical .sssZ string", () => {
      expect(epochMsToIso(1767225600000)).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  test("round-trips a non-canonical instant to its canonical form", () => {
    // An offset input stores its epoch and reads back canonical UTC.
    expect(epochMsToIso(instantToEpochMs("2026-01-01T01:00:00+01:00"))).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});
