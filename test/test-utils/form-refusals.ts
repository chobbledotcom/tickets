import { it as test } from "@std/testing/bdd";
import { expectErrorFlash } from "#test-utils/assertions.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Declare a test that posts one admin form with a required field left empty
 *  and asserts the handler refuses it with a 302 and a "required" error
 *  flash. */
export const testRejectsEmptyField = (
  name: string,
  path: string,
  body: Record<string, string>,
): void => {
  test(name, async () => {
    const { response } = await adminFormPost(path, body);
    expectErrorFlash(response, "required");
  });
};
