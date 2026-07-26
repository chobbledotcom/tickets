/**
 * The rules behind "a visitor could really send this". The stories lean on
 * these to refuse a value no visitor could choose, so each rule is checked
 * directly against markup rather than only through a page that happens to
 * render one shape today.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  optionsOffered,
  whyValueCannotBeSent,
} from "#test/specs/support/form-controls.ts";

describe("what a visitor can send", () => {
  const chooser = (options: string, attributes = 'name="date"') =>
    `<label>Day</label><select ${attributes}>${options}</select>`;

  const PLACEHOLDER = '<option value="" disabled selected>Pick a day</option>';
  const OPEN_DAY = '<option value="2026-08-10">10 August</option>';

  describe("a dropdown", () => {
    test("accepts a day the chooser offers", () => {
      expect(
        whyValueCannotBeSent(chooser(OPEN_DAY), "date", "2026-08-10"),
      ).toBeNull();
    });

    // The regression this file exists for: a switched-off placeholder sits in
    // real chooser markup, and must not condemn the day actually being picked.
    test("accepts a day even when a sibling option is switched off", () => {
      expect(
        whyValueCannotBeSent(
          chooser(`${PLACEHOLDER}${OPEN_DAY}`),
          "date",
          "2026-08-10",
        ),
      ).toBeNull();
    });

    test("refuses a day the chooser does not offer", () => {
      expect(
        whyValueCannotBeSent(chooser(OPEN_DAY), "date", "2026-09-01"),
      ).toBe('the date chooser does not offer "2026-09-01"');
    });

    test("refuses the very day that is switched off", () => {
      expect(
        whyValueCannotBeSent(
          chooser('<option value="2026-08-10" disabled>10 August</option>'),
          "date",
          "2026-08-10",
        ),
      ).toBe('the date option "2026-08-10" is switched off');
    });

    test("refuses a chooser that is switched off altogether", () => {
      expect(
        whyValueCannotBeSent(
          chooser(OPEN_DAY, 'name="date" disabled'),
          "date",
          "2026-08-10",
        ),
      ).toBe("the date chooser is switched off");
    });

    test("finds the chooser however its attributes are ordered", () => {
      expect(
        whyValueCannotBeSent(
          chooser(OPEN_DAY, 'id="date" required name="date"'),
          "date",
          "2026-08-10",
        ),
      ).toBeNull();
    });
  });

  describe("a box to fill in", () => {
    test("accepts anything typed into an ordinary box", () => {
      expect(
        whyValueCannotBeSent('<input type="text" name="name">', "name", "Jo"),
      ).toBeNull();
    });

    test("refuses a box that is switched off", () => {
      expect(
        whyValueCannotBeSent(
          '<input type="text" name="name" disabled>',
          "name",
          "Jo",
        ),
      ).toBe("the name box is switched off");
    });

    test("accepts a hidden box that already holds the value", () => {
      expect(
        whyValueCannotBeSent(
          '<input type="hidden" name="quantity_3" value="1">',
          "quantity_3",
          "1",
        ),
      ).toBeNull();
    });

    test("refuses a hidden box fixed at something else", () => {
      expect(
        whyValueCannotBeSent(
          '<input type="hidden" name="quantity_3" value="1">',
          "quantity_3",
          "2",
        ),
      ).toBe('the quantity_3 box is fixed at something other than "2"');
    });
  });

  test("refuses a field the page does not render at all", () => {
    expect(whyValueCannotBeSent("<p>nothing here</p>", "date", "x")).toBe(
      "the page has no date to fill in",
    );
  });

  describe("the values a dropdown offers", () => {
    test("lists them in the order the page renders them", () => {
      expect(
        optionsOffered(chooser(`${PLACEHOLDER}${OPEN_DAY}`), "date"),
      ).toEqual(["", "2026-08-10"]);
    });

    test("throws when the page has no such dropdown", () => {
      expect(() => optionsOffered("<p>nothing here</p>", "date")).toThrow(
        "The page offers no date to choose",
      );
    });
  });
});
