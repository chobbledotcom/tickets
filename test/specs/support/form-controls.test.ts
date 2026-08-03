/**
 * The rules behind "a visitor could really send this". The stories lean on
 * these to refuse a value no visitor could choose, so each rule is checked
 * directly against markup rather than only through a page that happens to
 * render one shape today.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  checkboxValueOffered,
  choicesOffered,
  expectCanReallySend,
  fillInAndSend,
  optionsOffered,
  requireCheckboxOffered,
  takeDownFromActions,
  tickedCheckboxes,
  whyValueCannotBeSent,
} from "#test/specs/support/form-controls.ts";

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

describe("the days a page has ticked", () => {
  const day = (value: string, attributes = "checked") =>
    `<input type="checkbox" name="bookable_days" value="${value}" ${attributes}>`;

  test("lists only the ticked ones", () => {
    expect(
      tickedCheckboxes(
        `${day("Monday")}${day("Tuesday", "")}`,
        "bookable_days",
      ),
    ).toEqual(["Monday"]);
  });

  test("leaves out a day nobody could untick", () => {
    // A hidden box carries the value but offers no way to clear it, and a
    // switched-off checkbox cannot be clicked either.
    const fixed = '<input type="hidden" name="bookable_days" value="Sunday">';
    const off = day("Friday", "checked disabled");
    expect(
      tickedCheckboxes(`${day("Monday")}${fixed}${off}`, "bookable_days"),
    ).toEqual(["Monday"]);
  });

  test("leaves out another field's ticked boxes", () => {
    const other = '<input type="checkbox" name="fields" value="email" checked>';
    expect(
      tickedCheckboxes(`${day("Monday")}${other}`, "bookable_days"),
    ).toEqual(["Monday"]);
  });

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

  describe("filling a form in and sending it", () => {
    /** A browser stand-in: it holds the page it was served and remembers what
     * was sent, so the helper's own two jobs can be seen separately. */
    const pageOffering = (html: string) => {
      const sent: Array<{ button: string; values: Record<string, string> }> =
        [];
      return {
        browser: {
          currentHtml: html,
          submitForm: (values: Record<string, string>, button: string) => {
            sent.push({ button, values });
            return Promise.resolve();
          },
        },
        sent,
      };
    };

    test("sends the values, naming the button that was pressed", async () => {
      const page = pageOffering('<input name="username" value="">');
      // deno-lint-ignore no-explicit-any
      await fillInAndSend(page.browser as any, { username: "sam" }, "Invite");
      expect(page.sent).toEqual([
        { button: "Invite", values: { username: "sam" } },
      ]);
    });

    test("sends nothing when a value could not really be sent", async () => {
      const page = pageOffering('<input name="username" value="" disabled>');
      await expect(
        // deno-lint-ignore no-explicit-any
        fillInAndSend(page.browser as any, { username: "sam" }, "Invite"),
      ).rejects.toThrow();
      expect(page.sent).toEqual([]);
    });
  });

  describe("taking a thing down from its own page", () => {
    /** A browser stand-in that remembers which links were followed and what
     * was sent, so the order of the journey can be seen. */
    const pageWithActions = () => {
      const followed: string[] = [];
      const sent: Record<string, string>[] = [];
      return {
        browser: {
          clickLink: (text: string) => {
            followed.push(text);
            return Promise.resolve();
          },
          currentHtml: '<input name="confirm_identifier" value="">',
          pageText: "Page deleted",
          submitForm: (values: Record<string, string>) => {
            sent.push(values);
            return Promise.resolve();
          },
        },
        followed,
        sent,
      };
    };

    /** One take-down, run through the helper the stories use. */
    const takeDown = (page: ReturnType<typeof pageWithActions>) =>
      // deno-lint-ignore no-explicit-any
      takeDownFromActions(page.browser as any, "Directions", {
        deleteLink: "Delete page",
        submit: "Delete",
      });

    /** The page after one take-down has been run through it. */
    const afterTakingDown = async () => {
      const page = pageWithActions();
      await takeDown(page);
      return page;
    };

    test("follows the Actions tab, then the delete link", async () => {
      expect((await afterTakingDown()).followed).toEqual([
        t("entity.tab.actions"),
        "Delete page",
      ]);
    });

    test("types the name into the box the page asks for", async () => {
      expect((await afterTakingDown()).sent).toEqual([
        { confirm_identifier: "Directions" },
      ]);
    });

    test("hands back what the site said", async () => {
      expect(await takeDown(pageWithActions())).toBe("Page deleted");
    });
  });
});
