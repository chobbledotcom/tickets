import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getTicketFieldsSetting,
  mergeListingFields,
  parseListingFields,
  withRequiredEmail,
} from "#shared/listing-fields.ts";
import { CONTACT_FIELDS } from "#types";

describe("listing-fields", () => {
  describe("parseListingFields", () => {
    test("returns empty array for empty string", () => {
      expect(parseListingFields("")).toEqual([]);
    });

    test("parses and trims comma-separated fields", () => {
      expect(parseListingFields(" email , phone ")).toEqual(["email", "phone"]);
    });

    test("drops tokens that are not recognised contact fields", () => {
      // Listings render contactFieldMap[f] directly; an unrecognised token
      // would produce undefined and crash form rendering.
      expect(parseListingFields("email,<script>,phone,DROP TABLE")).toEqual([
        "email",
        "phone",
      ]);
    });

    test("preserves input order of valid fields", () => {
      // Single-listing rendering uses this order verbatim, so it must not
      // silently re-sort.
      expect(parseListingFields("phone,email")).toEqual(["phone", "email"]);
    });
  });

  describe("mergeListingFields", () => {
    test("returns empty string when no settings are provided", () => {
      expect(mergeListingFields([])).toBe("");
    });

    test("returns fields in canonical order regardless of input order", () => {
      // Multi-listing booking must render fields consistently; the output
      // order must match CONTACT_FIELDS, not any single listing's order.
      const reversed = [...CONTACT_FIELDS].reverse().join(",");
      expect(mergeListingFields([reversed])).toBe(CONTACT_FIELDS.join(","));
    });

    test("returns union across settings without duplicates", () => {
      expect(mergeListingFields(["email,phone", "phone,address"])).toBe(
        "email,phone,address",
      );
    });

    test("ignores empty and unrecognised tokens while merging", () => {
      expect(mergeListingFields(["", "email,bogus", "phone"])).toBe(
        "email,phone",
      );
    });
  });

  describe("getTicketFieldsSetting", () => {
    // The parameter is structural: anything with a listing that names its
    // contact fields, so this module stays free of booking-model imports.
    const listingWith = (fields: string) => ({ listing: { fields } });

    test("is empty when the page has no listings", () => {
      expect(getTicketFieldsSetting([])).toBe("");
    });

    test("folds every listing's own setting into one", () => {
      expect(
        getTicketFieldsSetting([
          listingWith("email"),
          listingWith("phone,address"),
        ]),
      ).toBe("email,phone,address");
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
