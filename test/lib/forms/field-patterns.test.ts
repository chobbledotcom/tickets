import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Field } from "#shared/forms.tsx";
import {
  getBuiltSiteFields,
  getChangePasswordFields,
  getGroupCreateFields,
  getGroupFields,
  getHolidayFields,
  getInviteUserFields,
  getListingFields,
  getLoginFields,
  getSetupFields,
  getSlugField,
  getSquareAccessTokenFields,
  getSquareWebhookFields,
  getStripeKeyFields,
  getSumupFields,
  getTicketFields,
  PHONE_INPUT_PATTERN,
  SUBDOMAIN_INPUT_PATTERN,
} from "#templates/fields.ts";

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
const fieldGroups: { label: string; fields: Field[] }[] = [
  { fields: getLoginFields(), label: "login" },
  { fields: getSetupFields(), label: "setup" },
  { fields: getChangePasswordFields(), label: "changePassword" },
  { fields: getInviteUserFields(), label: "inviteUser" },
  { fields: getListingFields(), label: "listing" },
  { fields: getHolidayFields(), label: "holiday" },
  { fields: getBuiltSiteFields(), label: "builtSite" },
  { fields: getGroupCreateFields(), label: "groupCreate" },
  { fields: getGroupFields(), label: "group" },
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
});
