/**
 * Reading a served page's own checkboxes: which ones somebody could tick, what
 * ticking each would send, and which the page has ticked already.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkboxValueOffered,
  requireCheckboxOffered,
  tickedCheckboxes,
} from "#test/specs/support/form-controls/reading.ts";

// jscpd:ignore-end

describe("the days a page has ticked", () => {
  const day = (value: string, attributes = "checked") =>
    `<input type="checkbox" name="bookable_days" value="${value}" ${attributes}>`;

  /** What a page offers for its days, and the days somebody looking at it
   * would see already ticked and could untick again. */
  const READINGS: Array<{ offering: string; ticked: string[]; what: string }> =
    [
      {
        offering: `${day("Monday")}${day("Tuesday", "")}`,
        ticked: ["Monday"],
        what: "lists only the ticked ones",
      },
      {
        // A hidden box carries the value but offers no way to clear it, and a
        // switched-off checkbox cannot be clicked either.
        offering: `${day("Monday")}<input type="hidden" name="bookable_days" value="Sunday">${day("Friday", "checked disabled")}`,
        ticked: ["Monday"],
        what: "leaves out a day nobody could untick",
      },
      {
        offering: `${day("Monday")}<input type="checkbox" name="fields" value="email" checked>`,
        ticked: ["Monday"],
        what: "leaves out another field's ticked boxes",
      },
      {
        // "unchecked" contains "checked" and "not-disabled" contains
        // "disabled", so a page saying either in a value would otherwise have
        // its boxes misread — the clear one counted as ticked, the usable one
        // dropped as switched off.
        offering: `${day("unchecked", "")}${day("not-disabled")}`,
        ticked: ["not-disabled"],
        what: "does not read a word inside a value as a flag of its own",
      },
      {
        // A box with no value of its own sends "on", so it is still a box
        // somebody ticked — dropping it would hide the tick altogether.
        offering: '<input type="checkbox" name="bookable_days" checked>',
        ticked: ["on"],
        what: 'reads a box with no value of its own as sending "on"',
      },
      {
        // Another attribute ending in the one being read is a different
        // attribute: a typed-in box labelled `data-type="checkbox"` is not a
        // checkbox, and `data-name` is not the name a send would carry.
        offering: `${day("Monday")}<input type="text" data-type="checkbox" name="notes" value="Tuesday"><input type="checkbox" data-name="bookable_days" name="other" value="Sunday" checked>`,
        ticked: ["Monday"],
        what: "does not read a longer attribute name as the one asked for",
      },
    ];

  for (const reading of READINGS) {
    test(reading.what, () => {
      expect(tickedCheckboxes(reading.offering, "bookable_days")).toEqual(
        reading.ticked,
      );
    });
  }

  describe("the value a page's own box sends", () => {
    test("reads it off the box rather than assuming one", () => {
      expect(
        checkboxValueOffered(
          '<input type="checkbox" name="bookable_alone" value="on">',
          "bookable_alone",
        ),
      ).toBe("on");
    });

    test("ignores a box nobody could tick", () => {
      const off =
        '<input type="checkbox" name="bookable_alone" value="1" disabled>';
      const usable =
        '<input type="checkbox" name="bookable_alone" value="yes">';
      expect(checkboxValueOffered(`${off}${usable}`, "bookable_alone")).toBe(
        "yes",
      );
    });

    test("throws when the page offers no such box", () => {
      expect(() =>
        checkboxValueOffered("<p>nothing</p>", "bookable_alone"),
      ).toThrow("The page offers no bookable_alone box to tick");
    });
  });

  describe("requiring the box that sends one exact value", () => {
    const boxes =
      '<input type="checkbox" name="option_ids" value="4">' +
      '<input type="checkbox" name="option_ids" value="7">';

    test("passes when the page offers a box sending that value", () => {
      expect(() =>
        requireCheckboxOffered(boxes, "option_ids", "7"),
      ).not.toThrow();
    });

    test("throws naming the offered values when the box is missing", () => {
      expect(() => requireCheckboxOffered(boxes, "option_ids", "9")).toThrow(
        'The page offers no option_ids box sending "9" (offered: 4, 7)',
      );
    });

    test("says when the page offers no boxes at all", () => {
      expect(() =>
        requireCheckboxOffered("<p>nothing</p>", "option_ids", "9"),
      ).toThrow(
        'The page offers no option_ids box sending "9" (offered: none)',
      );
    });
  });
});
