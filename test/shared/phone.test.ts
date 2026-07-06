import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { normalizePhone, phoneLinks } from "#shared/phone.ts";

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

describe("phoneLinks", () => {
  test("builds tel and wa.me hrefs from a local number", () => {
    expect(phoneLinks("07700 900000", "44")).toEqual({
      tel: "tel:+447700900000",
      whatsapp: "https://wa.me/447700900000",
    });
  });

  test("wa.me link omits the leading plus", () => {
    expect(phoneLinks("07700 900000", "44")?.whatsapp).toBe(
      "https://wa.me/447700900000",
    );
  });

  test("tolerates a prefix that already includes a leading plus", () => {
    // settings.phonePrefix can be "+44"; the helper must not double the code.
    expect(phoneLinks("07700 900000", "+44")).toEqual({
      tel: "tel:+447700900000",
      whatsapp: "https://wa.me/447700900000",
    });
  });

  test("uses the given dialling code for non-UK numbers", () => {
    expect(phoneLinks("0234 567 8900", "1")).toEqual({
      tel: "tel:+12345678900",
      whatsapp: "https://wa.me/12345678900",
    });
  });

  test("returns null when the number has no digits", () => {
    expect(phoneLinks("", "44")).toBeNull();
    expect(phoneLinks("not a phone", "44")).toBeNull();
  });
});
