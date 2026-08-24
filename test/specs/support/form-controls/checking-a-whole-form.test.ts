/**
 * Checking a whole form's worth of values at once, before any of it is sent.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectCanReallySend,
  expectNothingInsistedIsEmpty,
} from "#test/specs/support/form-controls/rules.ts";

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

describe("what an untouched dropdown holds", () => {
  test("an insisted dropdown holds the option the page marked", () => {
    expectNothingInsistedIsEmpty(
      '<select name="tier" required><option value="">Pick</option><option value="gold" selected>Gold</option></select>',
      {},
    );
  });

  test("an insisted single-answer dropdown holds its first option", () => {
    expectNothingInsistedIsEmpty(
      '<select name="tier" required><option value="gold">Gold</option></select>',
      {},
    );
  });

  test("a marked option with no value of its own holds nothing", () => {
    expect(() =>
      expectNothingInsistedIsEmpty(
        '<select name="tier" required><option selected>Pick one</option></select>',
        {},
      ),
    ).toThrow("The tier box must be filled in to send the form");
  });

  test("a first option with no value of its own holds nothing", () => {
    expect(() =>
      expectNothingInsistedIsEmpty(
        '<select name="tier" required><option>Pick one</option></select>',
        {},
      ),
    ).toThrow("The tier box must be filled in to send the form");
  });

  test("an insisted many-answer list with nothing marked holds nothing", () => {
    expect(() =>
      expectNothingInsistedIsEmpty(
        '<select name="tiers" multiple required><option value="gold">Gold</option></select>',
        {},
      ),
    ).toThrow("The tiers box must be filled in to send the form");
  });
});
