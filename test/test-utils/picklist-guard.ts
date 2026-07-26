/**
 * One shared way to test a picklist's `isX` guard.
 *
 * Every guard narrows an arbitrary string to its typed union with
 * `v.is(Schema, value)`. Checking both arms — a real member is accepted, an
 * off-target string is rejected — is what kills a mutant that drops a member,
 * inverts the check, or lets an unrelated word through. The guards live in
 * several modules, so each one's cases sit beside the module that exports it
 * and they all call this.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";

/** Test that the guard says yes to every member and no to every non-member. */
export const checkBothArms = <T extends string>(
  guard: (s: string) => s is T,
  members: readonly T[],
  nonMembers: readonly string[],
): void => {
  for (const member of members) {
    test(`accepts ${JSON.stringify(member)}`, () => {
      expect(guard(member)).toBe(true);
    });
  }
  for (const other of nonMembers) {
    test(`rejects ${JSON.stringify(other)}`, () => {
      expect(guard(other)).toBe(false);
    });
  }
};
