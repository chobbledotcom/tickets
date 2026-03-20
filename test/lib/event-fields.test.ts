import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  mergeEventFields,
  parseEventFields,
  withRequiredEmail,
} from "#lib/event-fields.ts";

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
      expect(
        parseEventFields("email,phone,address,special_instructions"),
      ).toEqual(["email", "phone", "address", "special_instructions"]);
    });
  });

  describe("mergeEventFields", () => {
    test("returns empty string for empty array", () => {
      expect(mergeEventFields([])).toBe("");
    });

    test("returns empty string when all events have empty fields", () => {
      expect(mergeEventFields(["", ""])).toBe("");
    });

    test("returns union of fields in canonical order", () => {
      expect(mergeEventFields(["phone", "email"])).toBe("email,phone");
    });

    test("deduplicates across settings", () => {
      expect(mergeEventFields(["email,phone", "email,phone"])).toBe(
        "email,phone",
      );
    });

    test("merges disjoint field sets", () => {
      expect(mergeEventFields(["email", "phone,address"])).toBe(
        "email,phone,address",
      );
    });

    test("returns single field from single setting", () => {
      expect(mergeEventFields(["phone"])).toBe("phone");
    });
  });

  describe("withRequiredEmail", () => {
    test("returns unchanged when email already present", () => {
      expect(withRequiredEmail("email,phone")).toBe("email,phone");
    });

    test("prepends email when missing", () => {
      expect(withRequiredEmail("phone")).toBe("email,phone");
    });

    test("returns email for empty fields", () => {
      expect(withRequiredEmail("")).toBe("email");
    });

    test("prepends email when only non-email fields present", () => {
      expect(withRequiredEmail("phone,address")).toBe("email,phone,address");
    });
  });
});
