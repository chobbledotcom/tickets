/**
 * How short a value a box will take. Its own file because the rule is the one
 * that decides whether a story may send a password the page would refuse, and
 * a mutation run should be able to reach it without the whole form suite.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { whyValueCannotBeSent } from "#test/specs/support/form-controls.ts";

describe("a box that asks for a minimum length", () => {
  const password = (extra = "") =>
    `<input name="pass" type="password" minlength="8"${extra}>`;

  test("accepts a value long enough for the box", () => {
    expect(whyValueCannotBeSent(password(), "pass", "longenough")).toBeNull();
  });

  test("refuses a value shorter than the box asks for", () => {
    expect(whyValueCannotBeSent(password(), "pass", "short")).toBe(
      "the pass box takes nothing shorter than 8 characters",
    );
  });

  test("accepts a value of exactly the minimum", () => {
    expect(whyValueCannotBeSent(password(), "pass", "12345678")).toBeNull();
  });

  // An empty required box is already answered by the required rule, which
  // says something more useful than "too short".
  test("leaves an empty required box to the required rule", () => {
    expect(whyValueCannotBeSent(password(" required"), "pass", "")).toBe(
      "the pass box must be filled in",
    );
  });

  // Sending nothing at all through an optional box is a real answer, so its
  // minimum has nothing to measure. Without this the length rule would refuse
  // to leave a box empty that the page is happy to leave empty.
  test("lets an optional box be left empty", () => {
    expect(whyValueCannotBeSent(password(), "pass", "")).toBeNull();
  });

  test("ignores length on a box that asks for no minimum", () => {
    expect(
      whyValueCannotBeSent('<input name="pass" type="password">', "pass", "x"),
    ).toBeNull();
  });
});
