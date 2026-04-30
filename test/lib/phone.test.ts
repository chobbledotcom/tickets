import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { normalizePhone } from "#shared/phone.ts";

describe("normalizePhone", () => {
  test("strips non-numeric characters and adds prefix for leading zero", () => {
    expect(normalizePhone("07700 900000", "44")).toBe("+447700900000");
  });

  test("strips hyphens and parentheses", () => {
    expect(normalizePhone("(0)7700-900-000", "44")).toBe("+447700900000");
  });

  test("strips plus sign from input", () => {
    expect(normalizePhone("+447700900000", "44")).toBe("+447700900000");
  });

  test("adds + prefix for numbers not starting with zero", () => {
    expect(normalizePhone("447700900000", "44")).toBe("+447700900000");
  });

  test("returns empty string for empty input", () => {
    expect(normalizePhone("", "44")).toBe("");
  });

  test("returns empty string for whitespace-only input", () => {
    expect(normalizePhone("   ", "44")).toBe("");
  });

  test("returns empty string for non-numeric input", () => {
    expect(normalizePhone("abc", "44")).toBe("");
  });

  test("works with different prefix values", () => {
    expect(normalizePhone("0234 567 8900", "1")).toBe("+12345678900");
  });

  test("does not double-prefix when number already has country code", () => {
    expect(normalizePhone("12345678900", "1")).toBe("+12345678900");
  });

  test("handles number with spaces and leading zero", () => {
    expect(normalizePhone("0 20 1234 5678", "44")).toBe("+442012345678");
  });

  test("strips spurious zero after country code: 44 0161 1234567", () => {
    expect(normalizePhone("44 0161 1234567", "44")).toBe("+441611234567");
  });

  test("strips spurious zero after +country code: +44 0161 1234567", () => {
    expect(normalizePhone("+44 0161 1234567", "44")).toBe("+441611234567");
  });

  test("strips spurious zero with parenthesized country code: (44) 0161 1234567", () => {
    expect(normalizePhone("(44) 0161 1234567", "44")).toBe("+441611234567");
  });

  test("normalizes +44 161 1234567", () => {
    expect(normalizePhone("+44 161 1234567", "44")).toBe("+441611234567");
  });

  test("normalizes 44 161 1234567", () => {
    expect(normalizePhone("44 161 1234567", "44")).toBe("+441611234567");
  });

  test("normalizes 0161 1234567", () => {
    expect(normalizePhone("0161 1234567", "44")).toBe("+441611234567");
  });
});
