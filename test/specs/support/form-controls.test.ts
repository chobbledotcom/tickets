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
      const sent: Array<{
        button: string;
        values: Record<string, string | string[]>;
      }> = [];
      return {
        browser: {
          currentHtml: html,
          // The stand-in serves one form, so the body a button would send is
          // the whole of it. Which form a button belongs to is the browser's
          // own job, and is checked against real markup in its own tests.
          formBodyFor: () => html,
          submitForm: (
            values: Record<string, string | string[]>,
            button: string,
          ) => {
            sent.push({ button, values });
            return Promise.resolve();
          },
        },
        sent,
      };
    };

    /** Fill in and send the page the stand-in is serving. Its browser is only
     * the handful of parts this helper touches, so it is passed as one. */
    const sendOn = (
      page: ReturnType<typeof pageOffering>,
      values: Record<string, string>,
      ticked?: Record<string, string[]>,
      // deno-lint-ignore no-explicit-any
    ): Promise<void> =>
      fillInAndSend(page.browser as any, values, "Invite", ticked);

    const NAME_BOX = '<input name="username" value="">';
    const dayBox = (insisted = "") =>
      `<input type="checkbox" name="days" value="Monday"${insisted}>`;
    const DAY_BOX = dayBox();

    /** The same person typing and ticking the same thing throughout, so each
     * example below differs only in what the page offered them. */
    const TYPED = { username: "sam" };
    const TICKED = { days: ["Monday"] };

    /** Ticking the day and typing the name, and both going through. Two
     * examples below share it, because a ticked box goes through whether or not
     * the page insisted on it. */
    const TICKS_AND_TYPES = {
      sends: { ...TICKED, ...TYPED },
      ticked: TICKED,
      typed: TYPED,
    };

    /** One filling-in: what the page offers, what is typed and ticked into it,
     * and what comes of it — the one send it makes, or the words it is refused
     * with. A refusal must also leave nothing sent, which is checked for every
     * one of them. */
    const FILLINGS: Array<{
      offering: string;
      refusedWith?: string;
      sends?: Record<string, string | string[]>;
      ticked?: Record<string, string[]>;
      typed: Record<string, string>;
      what: string;
    }> = [
      {
        offering: NAME_BOX,
        sends: { ...TYPED },
        typed: TYPED,
        what: "sends the values, naming the button that was pressed",
      },
      {
        ...TICKS_AND_TYPES,
        offering: `${NAME_BOX}${DAY_BOX}`,
        what: "sends the boxes that were ticked alongside what was typed",
      },
      {
        offering: `${NAME_BOX}${DAY_BOX}`,
        sends: { days: [] },
        ticked: { days: [] },
        typed: {},
        what: "sends a box left clear as nothing at all",
      },
      {
        offering: '<input name="username" value="" disabled>',
        refusedWith: "the username box is switched off",
        typed: TYPED,
        what: "sends nothing when a value could not really be sent",
      },
      {
        offering: NAME_BOX,
        refusedWith: 'The page offers no days box sending "Monday"',
        ticked: TICKED,
        typed: TYPED,
        what: "sends nothing when the page offers no such box to tick",
      },
      {
        offering: NAME_BOX,
        refusedWith: "The page offers no days box to tick",
        ticked: { days: [] },
        typed: TYPED,
        what: "sends nothing when the box left clear is not on the page",
      },
      {
        offering: `${NAME_BOX}${dayBox(" required")}`,
        refusedWith: "The days box must be ticked to send the form",
        ticked: { days: [] },
        typed: TYPED,
        what: "sends nothing when the box left clear is one the page insists on",
      },
      {
        ...TICKS_AND_TYPES,
        offering: `${NAME_BOX}${dayBox(" required")}`,
        what: "sends a box the page insists on once it is ticked",
      },
      {
        offering: `${NAME_BOX}<input type="checkbox" name="terms" value="yes" required>`,
        refusedWith: "The terms box must be ticked to send the form",
        typed: TYPED,
        what: "sends nothing when the page insists on a box nobody mentioned",
      },
      {
        offering: `${NAME_BOX}<input type="checkbox" name="terms" value="yes" required checked>`,
        sends: { ...TYPED },
        typed: TYPED,
        what: "sends when the page has already ticked the box it insists on",
      },
      {
        // A box with no value of its own still insists on being ticked, and a
        // browser would refuse to send the form without it.
        offering: `${NAME_BOX}<input type="checkbox" name="terms" required>`,
        refusedWith: "The terms box must be ticked to send the form",
        typed: TYPED,
        what: "sends nothing when the insisted box has no value of its own",
      },
      {
        offering: `${NAME_BOX}<input type="checkbox" name="terms" required>`,
        sends: { terms: ["on"], ...TYPED },
        ticked: { terms: ["on"] },
        typed: TYPED,
        what: 'ticks a box with no value of its own by sending "on"',
      },
      {
        // The story types a name and never mentions the reference box, but a
        // browser would not send the form while that box sits empty.
        offering: `${NAME_BOX}<input name="reference" required>`,
        refusedWith: "The reference box must be filled in to send the form",
        typed: TYPED,
        what: "sends nothing when a box the page insists on is left empty",
      },
      {
        offering: `${NAME_BOX}<input name="reference" value="AB-1" required>`,
        sends: { ...TYPED },
        typed: TYPED,
        what: "sends when the page has already filled the box it insists on",
      },
      {
        offering: `${NAME_BOX}<textarea name="reason" required></textarea>`,
        refusedWith: "The reason box must be filled in to send the form",
        typed: TYPED,
        what: "sends nothing when a writing space the page insists on is empty",
      },
      {
        // No option is marked, so a browser would leave the empty first one
        // showing — which is no answer at all for a chooser it insists on.
        offering: `${NAME_BOX}<select name="tier" required><option value=""></option><option value="gold">Gold</option></select>`,
        refusedWith: "The tier box must be filled in to send the form",
        typed: TYPED,
        what: "sends nothing when an insisted chooser starts on no answer",
      },
      {
        offering: `${NAME_BOX}<select name="tier" required><option value=""></option><option value="gold" selected>Gold</option></select>`,
        sends: { ...TYPED },
        typed: TYPED,
        what: "sends when an insisted chooser already has an answer picked",
      },
      {
        // Nothing switched off is sent, and a browser holds no form up for it.
        offering: `${NAME_BOX}<input name="reference" value="" required disabled>`,
        sends: { ...TYPED },
        typed: TYPED,
        what: "sends when the only empty insisted box is switched off",
      },
      {
        offering: `${NAME_BOX}<select name="tier" required></select>`,
        refusedWith: "The tier box must be filled in to send the form",
        typed: TYPED,
        what: "sends nothing when an insisted chooser offers no answers at all",
      },
      {
        // A chooser that starts on a switched-off placeholder is the ordinary
        // way of saying "pick something" — the placeholder is switched off, the
        // chooser is not, and it still has no answer.
        offering: `${NAME_BOX}<select name="tier" required><option value="" disabled selected>Choose a tier</option><option value="gold">Gold</option></select>`,
        refusedWith: "The tier box must be filled in to send the form",
        typed: TYPED,
        what: "sends nothing when an insisted chooser sits on its placeholder",
      },
      {
        // The words on an option are what somebody reads, not flags on the
        // chooser holding it — this one is not insisted on at all, so sitting
        // on its empty first choice is nobody's problem.
        offering: `${NAME_BOX}<select name="tier"><option value="">Not required </option><option value="gold">Gold</option></select>`,
        sends: { ...TYPED },
        typed: TYPED,
        what: "does not read a word on an option as a flag on its chooser",
      },
      {
        // A tick, a fixed value, and a control with no name to send under are
        // each somebody else's rule, so none of them holds this form up.
        offering: `${NAME_BOX}<input type="radio" name="pick" required><input type="hidden" name="token" value="" required><input value="" required>`,
        sends: { ...TYPED },
        typed: TYPED,
        what: "sends when the only empty insisted controls are not typed in",
      },
    ];

    for (const example of FILLINGS) {
      test(example.what, async () => {
        const page = pageOffering(example.offering);
        const filledIn = sendOn(page, example.typed, example.ticked);
        if (example.refusedWith === undefined) {
          await filledIn;
          expect(page.sent).toEqual([
            { button: "Invite", values: example.sends },
          ]);
          return;
        }
        await expect(filledIn).rejects.toThrow(example.refusedWith);
        expect(page.sent).toEqual([]);
      });
    }
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
          formBodyFor: () => '<input name="confirm_identifier" value="">',
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
