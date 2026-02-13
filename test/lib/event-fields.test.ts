import { describe, expect, test } from "#test-compat";
import { mergeEventFields, parseEventFields } from "#lib/event-fields.ts";

describe("event-fields", () => {
  describe("parseEventFields", () => {
    test("returns empty array for empty string", () => {
      expect(parseEventFields("")).toEqual([]);
    });

    test("parses single field", () => {
      expect(parseEventFields("email")).toEqual(["email"]);
    });

    test("parses comma-separated fields", () => {
      expect(parseEventFields("email,phone")).toEqual(["email", "phone"]);
    });

    test("trims whitespace", () => {
      expect(parseEventFields(" email , phone ")).toEqual(["email", "phone"]);
    });

    test("filters invalid fields", () => {
      expect(parseEventFields("email,bogus,phone")).toEqual(["email", "phone"]);
    });

    test("parses all four contact fields", () => {
      expect(parseEventFields("email,phone,address,special_instructions"))
        .toEqual(["email", "phone", "address", "special_instructions"]);
    });
  });

  describe("mergeEventFields", () => {
    test("returns email for empty array", () => {
      expect(mergeEventFields([])).toBe("email");
    });

    test("returns union of fields in canonical order", () => {
      expect(mergeEventFields(["phone", "email"])).toBe("email,phone");
    });

    test("deduplicates across settings", () => {
      expect(mergeEventFields(["email,phone", "email,phone"])).toBe("email,phone");
    });

    test("merges disjoint field sets", () => {
      expect(mergeEventFields(["email", "phone,address"])).toBe("email,phone,address");
    });

    test("returns single field from single setting", () => {
      expect(mergeEventFields(["phone"])).toBe("phone");
    });
  });
});
