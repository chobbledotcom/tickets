/**
 * Pure unit tests for the picklist pattern's `isX` guards introduced across
 * several modules. Each guard narrows an arbitrary string to its typed union
 * via `v.is(Schema, value)`; these tests exercise both arms (positive members
 * and off-target values) so a mutant that drops a member, inverts the
 * predicate, or accepts an unrelated literal is killed. The cases are
 * table-driven and deterministic — no DB or harness needed, so mutation
 * testing stays fast.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isAttendeeSort } from "#shared/db/attendees/queries.ts";
// jscpd:ignore-end
import { isContactChannel } from "#shared/db/contact-preferences.ts";
import { isEmailTemplateFormat, isEmailTemplateType } from "#shared/types.ts";

/** A member and a non-member assert the guard's two arms. */
const checkBothArms = <T extends string>(
  guard: (s: string) => s is T,
  members: readonly T[],
  nonMembers: readonly string[],
): void => {
  for (const m of members) {
    test(`accepts ${JSON.stringify(m)}`, () => {
      expect(guard(m)).toBe(true);
    });
  }
  for (const bad of nonMembers) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(guard(bad)).toBe(false);
    });
  }
};

describe("EmailTemplateType picklist", () => {
  checkBothArms(
    isEmailTemplateType,
    ["confirmation", "admin"],
    ["", "Confirmation", "admin ", "owner", "newsletter"],
  );
});

describe("EmailTemplateFormat picklist", () => {
  checkBothArms(
    isEmailTemplateFormat,
    ["subject", "html", "text"],
    ["", "Subject", "body", "html_body", "TEXT"],
  );
});

describe("AttendeeSort picklist", () => {
  checkBothArms(
    isAttendeeSort,
    ["newest", "oldest"],
    ["", "new", "old", "recent", "Newest"],
  );
});

describe("ContactChannel picklist", () => {
  checkBothArms(
    isContactChannel,
    ["email", "sms"],
    ["", "Email", "phone", "whatsapp", "sms ", "push"],
  );
});
