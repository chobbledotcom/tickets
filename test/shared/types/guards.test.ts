/**
 * Pure unit tests for the guards `types.ts` exports itself. Table-driven and
 * deterministic — no DB or harness needed, so mutation testing stays fast.
 * Guards exported by other modules are tested beside those modules.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { checkBothArms } from "#test-utils/picklist-guard.ts";
import {
  CONTACT_FIELDS,
  isContactField,
  isImageUseItemType,
  isListingType,
  isPaymentProvider,
  isPaymentProviderSetting,
  isRecord,
  isSitePageItemType,
  isSuperuserChoice,
} from "#types";

describe("isRecord", () => {
  /** What a caller means by "a plain object of keys and values", and every
   * near miss that is not one. `typeof null` and `typeof []` are both
   * "object", so each needs its own arm of the guard. */
  const CASES: Array<{ is: boolean; value: unknown; what: string }> = [
    { is: true, value: {}, what: "an empty object" },
    { is: true, value: { a: 1 }, what: "an object with keys" },
    { is: false, value: null, what: "null" },
    { is: false, value: undefined, what: "undefined" },
    { is: false, value: [], what: "an empty array" },
    { is: false, value: [1, 2], what: "an array with items" },
    { is: false, value: 5, what: "a number" },
    { is: false, value: 0, what: "zero" },
    { is: false, value: "x", what: "a string" },
    { is: false, value: true, what: "a boolean" },
  ];

  for (const { is, value, what } of CASES) {
    test(`${is ? "accepts" : "rejects"} ${what}`, () => {
      expect(isRecord(value)).toBe(is);
    });
  }
});

describe("SuperuserChoice picklist", () => {
  checkBothArms(
    isSuperuserChoice,
    ["", "self-managed", "enabled"],
    ["disabled", "Enabled", "self managed", "self_managed", "superuser"],
  );
});

describe("ImageUseItemType picklist", () => {
  checkBothArms(
    isImageUseItemType,
    ["listing", "group", "news", "page"],
    ["", "Listing", "attendee", "pages", "news-post"],
  );
});

describe("SitePageItemType picklist", () => {
  // "news" is a real image target but not a site-page target, so it belongs on
  // the rejected side: the two lists are not the same list.
  checkBothArms(
    isSitePageItemType,
    ["listing", "group", "page"],
    ["", "news", "Page", "groups", "site-page"],
  );
});

describe("ContactField picklist", () => {
  checkBothArms(
    isContactField,
    ["email", "phone", "address", "special_instructions"],
    ["", "Email", "name", "notes", "phone_number"],
  );

  test("is the list the rest of the app reads its fields from", () => {
    // CONTACT_FIELDS is derived from the schema, so a member that changed
    // spelling would quietly change every loop over the contact fields.
    expect(CONTACT_FIELDS).toEqual([
      "email",
      "phone",
      "address",
      "special_instructions",
    ]);
  });
});

describe("PaymentProvider picklist", () => {
  checkBothArms(
    isPaymentProvider,
    ["stripe", "square", "sumup"],
    ["", "none", "Stripe", "paypal", "sum-up"],
  );
});

describe("PaymentProviderSetting picklist", () => {
  // The stored setting is a provider or the word for "take no payments", so
  // "none" belongs here and nowhere else.
  checkBothArms(
    isPaymentProviderSetting,
    ["stripe", "square", "sumup", "none"],
    ["", "None", "off", "disabled"],
  );
});

describe("ListingType picklist", () => {
  checkBothArms(
    isListingType,
    ["standard", "daily"],
    ["", "Standard", "weekly", "day"],
  );
});
