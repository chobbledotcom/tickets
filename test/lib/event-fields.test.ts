import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  mergeEventFields,
  parseEventFields,
  withRequiredEmail,
} from "#lib/event-fields.ts";
import { CONTACT_FIELDS } from "#lib/types.ts";

describe("event-fields", () => {
  describe("parseEventFields", () => {
    test("returns empty array for empty string", () => {
      expect(parseEventFields("")).toEqual([]);
    });

    test("parses and trims comma-separated fields", () => {
      expect(parseEventFields(" email , phone ")).toEqual(["email", "phone"]);
    });

    test("drops tokens that are not recognised contact fields", () => {
      // Events render contactFieldMap[f] directly; an unrecognised token
      // would produce undefined and crash form rendering.
      expect(parseEventFields("email,<script>,phone,DROP TABLE")).toEqual([
        "email",
        "phone",
      ]);
    });

    test("preserves input order of valid fields", () => {
      // Single-event rendering uses this order verbatim, so it must not
      // silently re-sort.
      expect(parseEventFields("phone,email")).toEqual(["phone", "email"]);
    });
  });

  describe("mergeEventFields", () => {
    test("returns empty string when no settings are provided", () => {
      expect(mergeEventFields([])).toBe("");
    });

    test("returns fields in canonical order regardless of input order", () => {
      // Multi-event booking must render fields consistently; the output
      // order must match CONTACT_FIELDS, not any single event's order.
      const reversed = [...CONTACT_FIELDS].reverse().join(",");
      expect(mergeEventFields([reversed])).toBe(CONTACT_FIELDS.join(","));
    });

    test("returns union across settings without duplicates", () => {
      expect(mergeEventFields(["email,phone", "phone,address"])).toBe(
        "email,phone,address",
      );
    });

    test("ignores empty and unrecognised tokens while merging", () => {
      expect(mergeEventFields(["", "email,bogus", "phone"])).toBe(
        "email,phone",
      );
    });
  });

  describe("withRequiredEmail", () => {
    test("prepends email when missing", () => {
      expect(withRequiredEmail("phone,address")).toBe("email,phone,address");
    });

    test("returns email alone for empty input", () => {
      expect(withRequiredEmail("")).toBe("email");
    });

    test("returns input unchanged when email is already present", () => {
      // Idempotence matters: Square checkout calls this on every request.
      const input = "email,phone";
      expect(withRequiredEmail(input)).toBe(input);
    });
  });
});
