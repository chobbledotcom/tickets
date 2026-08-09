/**
 * Whether a visitor could really send one value through the control the page
 * renders for it: a dropdown has to offer the option, a box has to be one they
 * can type into, and each carries its own limits.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  choicesOffered,
  optionsOffered,
} from "#test/specs/support/form-controls/reading.ts";
import { whyValueCannotBeSent } from "#test/specs/support/form-controls/rules.ts";

// jscpd:ignore-end

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

  describe("the choices a dropdown offers", () => {
    test("gives the words a person reads beside the value they send", () => {
      expect(
        choicesOffered(chooser(`${PLACEHOLDER}${OPEN_DAY}`), "date"),
      ).toEqual([
        { label: "Pick a day", value: "" },
        { label: "10 August", value: "2026-08-10" },
      ]);
    });

    test("reads the words through any markup inside the option", () => {
      expect(
        choicesOffered(
          chooser('<option value="2026-08-11"> <b>11</b> August </option>'),
          "date",
        ),
      ).toEqual([{ label: "11 August", value: "2026-08-11" }]);
    });

    test("gives an option carrying no value at all an empty one", () => {
      expect(
        choicesOffered(chooser("<option selected>Any day</option>"), "date"),
      ).toEqual([{ label: "Any day", value: "" }]);
    });
  });
});

describe("a box that cannot be changed or cannot hold the number", () => {
  const lengthBox = (attributes: string) =>
    `<input type="number" name="duration_days" ${attributes}>`;

  test("refuses a box the page shows but will not let anyone edit", () => {
    expect(
      whyValueCannotBeSent(
        lengthBox('value="1" readonly'),
        "duration_days",
        "5",
      ),
    ).toBe("the duration_days box cannot be changed");
  });

  test("refuses leaving a box empty when the page insists on it", () => {
    expect(
      whyValueCannotBeSent(lengthBox("required"), "duration_days", ""),
    ).toBe("the duration_days box must be filled in");
  });

  test("allows leaving an optional box empty", () => {
    expect(whyValueCannotBeSent(lengthBox(""), "duration_days", "")).toBeNull();
  });

  test("does not read a word inside a value as an on/off attribute", () => {
    // "required" and "disabled" appear here only inside quoted values, which
    // say nothing about whether the box itself carries either.
    const box =
      '<input type="number" name="duration_days" aria-required="false" ' +
      'placeholder="disabled if not required">';

    expect(whyValueCannotBeSent(box, "duration_days", "")).toBeNull();
    expect(whyValueCannotBeSent(box, "duration_days", "2")).toBeNull();
  });

  test("refuses a number above what the box takes", () => {
    expect(
      whyValueCannotBeSent(lengthBox('min="1" max="3"'), "duration_days", "5"),
    ).toBe("the duration_days box takes nothing above 3");
  });

  test("refuses a number below what the box takes", () => {
    expect(
      whyValueCannotBeSent(lengthBox('min="2" max="9"'), "duration_days", "1"),
    ).toBe("the duration_days box takes nothing below 2");
  });

  test("allows a number inside what the box takes", () => {
    expect(
      whyValueCannotBeSent(lengthBox('min="1" max="9"'), "duration_days", "5"),
    ).toBeNull();
  });

  test("leaves a box with no limits alone", () => {
    expect(
      whyValueCannotBeSent(lengthBox('value="1"'), "duration_days", "5"),
    ).toBeNull();
  });

  test("has no range to break for a word or an empty box", () => {
    const box = '<input type="text" name="name" min="2" max="3">';
    expect(whyValueCannotBeSent(box, "name", "Ada")).toBeNull();
    expect(whyValueCannotBeSent(box, "name", "")).toBeNull();
  });
});
