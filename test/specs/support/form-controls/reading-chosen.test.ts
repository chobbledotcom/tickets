/**
 * Reading what a served page has already picked: the option a dropdown marks
 * as selected, and the answer a question already has ticked. The refused-order
 * stories lean on these to prove a refusal hands back what was typed.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  answerTicked,
  optionChosen,
  optionMarkedChosen,
} from "#test/specs/support/form-controls/reading.ts";

// jscpd:ignore-end

const chooser = (options: string): string =>
  `<select name="date">${options}</select>`;

describe("optionMarkedChosen", () => {
  test("gives the marked option's attributes", () => {
    expect(
      optionMarkedChosen('<option value="1"><option value="2" selected>'),
    ).toBe('value="2" selected');
  });

  test("gives null when no option is marked", () => {
    expect(optionMarkedChosen('<option value="1"><option value="2">')).toBe(
      null,
    );
  });
});

describe("optionChosen", () => {
  test("gives the value the dropdown has already picked", () => {
    expect(
      optionChosen(
        chooser('<option value="a"><option value="b" selected>'),
        "date",
      ),
    ).toBe("b");
  });

  test("gives null when the dropdown has picked nothing", () => {
    expect(
      optionChosen(chooser('<option value="a"><option value="b">'), "date"),
    ).toBe(null);
  });

  test("reads a marked option with no value of its own as empty", () => {
    expect(
      optionChosen(chooser("<option selected>Pick</option>"), "date"),
    ).toBe("");
  });

  test("throws when the page has no such dropdown", () => {
    expect(() => optionChosen("<p>No form here</p>", "date")).toThrow(
      "no date to choose",
    );
  });
});

describe("answerTicked", () => {
  test("gives the ticked answer's value", () => {
    expect(
      answerTicked(
        '<input type="radio" name="question_1" value="4">' +
          '<input type="radio" name="question_1" value="5" checked>',
        "question_1",
      ),
    ).toBe("5");
  });

  test("gives null when nothing is ticked", () => {
    expect(
      answerTicked(
        '<input type="radio" name="question_1" value="4">',
        "question_1",
      ),
    ).toBe(null);
  });

  test("ignores a tick on some other question", () => {
    expect(
      answerTicked(
        '<input type="radio" name="question_2" value="4" checked>',
        "question_1",
      ),
    ).toBe(null);
  });

  test("reads a ticked answer with no value as the browser's own word", () => {
    expect(
      answerTicked(
        '<input type="radio" name="question_1" checked>',
        "question_1",
      ),
    ).toBe("on");
  });
});
