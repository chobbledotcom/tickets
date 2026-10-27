import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Field } from "#shared/forms/field.ts";
import {
  getBuiltSiteForm,
  getChangePasswordForm,
  getHolidayForm,
  getInviteUserForm,
  getLoginForm,
  getSetupForm,
  getSquareAccessTokenFields,
  getSquareWebhookFields,
  getStripeKeyFields,
  getSumupFields,
} from "#templates/fields/admin.ts";
import { getGroupCreateForm, getGroupForm } from "#templates/fields/group.ts";
import { getListingForm } from "#templates/fields/listing.ts";
import {
  getTicketFields,
  PHONE_INPUT_PATTERN,
  SUBDOMAIN_INPUT_PATTERN,
} from "#templates/fields/ticket.ts";
import {
  getSlugField,
  getUsernameFieldBase,
  validateUsername,
} from "#templates/fields/validators.ts";

/**
 * Regression guard for HTML `pattern` attributes.
 *
 * Browsers compile the `pattern` attribute with the RegExp `v` (unicodeSets)
 * flag, which is stricter than the default: an unescaped `-` or `(`/`)` inside a
 * character class throws "Invalid character in character class". When that
 * happens the constraint is silently dropped AND the browser logs an uncaught
 * SyntaxError on every validation — e.g. `[a-zA-Z0-9_-]+` on the username field
 * broke real logins on recent Chromium and hung the payment e2e harness. Every
 * pattern we render must therefore compile under BOTH `v` and the default mode.
 */
const expectValidPattern = (pattern: string): void => {
  expect(() => new RegExp(pattern, "v")).not.toThrow();
  expect(() => new RegExp(pattern)).not.toThrow();
};

// Every field group that could carry a `pattern`. getTicketFields is called with
// "phone" so the phone field's pattern is included.
const fieldGroups: { label: string; fields: readonly Field[] }[] = [
  { fields: getLoginForm().fields, label: "login" },
  { fields: getSetupForm().fields, label: "setup" },
  { fields: getChangePasswordForm().fields, label: "changePassword" },
  { fields: getInviteUserForm().fields, label: "inviteUser" },
  { fields: getListingForm().fields, label: "listing" },
  { fields: getHolidayForm().fields, label: "holiday" },
  { fields: getBuiltSiteForm().fields, label: "builtSite" },
  { fields: getGroupCreateForm().fields, label: "groupCreate" },
  { fields: getGroupForm().fields, label: "group" },
  { fields: [getSlugField()], label: "slug" },
  { fields: getStripeKeyFields(), label: "stripe" },
  { fields: getSquareAccessTokenFields(), label: "squareToken" },
  { fields: getSquareWebhookFields(), label: "squareWebhook" },
  { fields: getSumupFields(), label: "sumup" },
  { fields: getTicketFields("phone", false), label: "ticket:phone" },
];

describe("HTML input pattern attributes compile under the RegExp `v` flag", () => {
  for (const { label, fields } of fieldGroups) {
    for (const field of fields) {
      if (typeof field.pattern !== "string") continue;
      test(`${label} field "${field.name}" pattern is valid`, () => {
        expectValidPattern(field.pattern as string);
      });
    }
  }

  test("PHONE_INPUT_PATTERN is valid (shared by ticket + attendee forms)", () => {
    expectValidPattern(PHONE_INPUT_PATTERN);
    // Sanity: the pattern still accepts a normal phone number and rejects junk.
    const re = new RegExp(`^${PHONE_INPUT_PATTERN}$`, "v");
    expect(re.test("+44 20 7946 0000")).toBe(true);
    expect(re.test("hello")).toBe(false);
  });

  test("SUBDOMAIN_INPUT_PATTERN is valid (subdomain settings form)", () => {
    expectValidPattern(SUBDOMAIN_INPUT_PATTERN);
    const re = new RegExp(`^${SUBDOMAIN_INPUT_PATTERN}$`, "v");
    expect(re.test("my-shop")).toBe(true);
    expect(re.test("-bad")).toBe(false);
  });

  // The browser can only check the shape, and validateUsername refuses a
  // leading hyphen or underscore. The login and invite boxes carry the same
  // schema-shaped pattern as the setup field, so the browser refuses exactly
  // what the server refuses. Every shape the schema draws a line at is
  // enumerated: leading punctuation, inner and trailing punctuation, the
  // characters outside the set, and the length the maxlength attribute owns.
  test("the shared username pattern refuses what validateUsername refuses", () => {
    const pattern = getUsernameFieldBase().pattern;
    assert(pattern !== undefined, "the username field carries a pattern");
    expectValidPattern(pattern);
    const re = new RegExp(`^${pattern}$`, "v");

    for (const value of [
      "a",
      "Z",
      "9",
      "aB",
      "0-0",
      "a-b_c",
      "aB-9_z",
      "a-_b",
      "abc-",
      "abc_",
      "a--b",
      "a__b",
      "-abc",
      "_abc",
      "-",
      "_",
      "-9",
      "_9",
      "x!",
      "x.y",
      "x y",
      "x@y",
      "x+y",
      "üñï",
      "日本語",
      "xü",
      "a\tb",
      "a".repeat(250),
      `${"a".repeat(249)}-`,
      `-${"a".repeat(249)}`,
      "9".repeat(250),
    ]) {
      expect(validateUsername(value) === null, `"${value}"`).toBe(
        re.test(value),
      );
    }
  });

  // The setup field spells its pattern out beside the shared base, so the two
  // copies must stay the same string: a drift would let the setup box and the
  // login box disagree about one name.
  test("the setup field carries the shared username pattern", () => {
    const setupUsername = getSetupForm().fields.find(
      (field) => field.name === "admin_username",
    );
    assert(setupUsername !== undefined, "the setup form has a username box");
    expect(setupUsername.pattern).toBe(getUsernameFieldBase().pattern);
  });
});
