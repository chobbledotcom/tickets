/**
 * Checking a whole form's worth of values at once, before any of it is sent.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expectCanReallySend } from "#test/specs/support/form-controls/rules.ts";

// jscpd:ignore-end

describe("checking a whole form's worth of values at once", () => {
  const form =
    '<input name="username" value="">' +
    '<input name="max_attendees" type="number" min="1" max="10">';

  test("passes when every value could really be sent", () => {
    expectCanReallySend(form, { max_attendees: "5", username: "sam" });
  });

  test("names the first box that could not carry its value", () => {
    expect(() =>
      expectCanReallySend(form, { max_attendees: "50", username: "sam" }),
    ).toThrow("the max_attendees box takes nothing above 10");
  });

  test("fails on a box the page never offered", () => {
    expect(() => expectCanReallySend(form, { webhook_url: "x" })).toThrow(
      "the page has no webhook_url to fill in",
    );
  });
});
