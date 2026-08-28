import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type CommaSplit, topLevelCommas } from "#shared/top-level-commas.ts";

/** The SQL shape: parens only, whole text, never stops early. */
const sqlShape = (): CommaSplit => ({
  closers: ")",
  openers: "(",
  start: 0,
  stopWhenClosed: false,
});

/** The call shape: every bracket, stops at the closer. */
const callShape = (open: number): CommaSplit => ({
  closers: ")]}",
  openers: "([{",
  start: open + 1,
  stopWhenClosed: true,
});

/** The pieces a comma list cuts out of one text, between `start` and `end`. */
const pieces = (
  text: string,
  commas: readonly number[],
  end: number,
  start = 0,
): string[] => {
  const cut = commas.map((comma) => {
    const piece = text.slice(start, comma).trim();
    start = comma + 1;
    return piece;
  });
  const tail = text.slice(start, end).trim();
  if (tail !== "") cut.push(tail);
  return cut;
};

describe("top level commas", () => {
  test("names every comma that sits at the target depth", () => {
    const clause = "a=1, b=2, c=3";
    const { commas, end } = topLevelCommas(clause, sqlShape());

    expect(pieces(clause, commas, end)).toEqual(["a=1", "b=2", "c=3"]);
  });

  test("skips commas inside nested brackets", () => {
    const clause = "a=coalesce(x, 0), b=2";
    const { commas, end } = topLevelCommas(clause, sqlShape());

    expect(pieces(clause, commas, end)).toEqual(["a=coalesce(x, 0)", "b=2"]);
  });

  test("reads only from the start index", () => {
    const blank = "call( a, pick(b, c), d )";
    const open = blank.indexOf("(");
    const { commas, end } = topLevelCommas(blank, callShape(open));

    expect(pieces(blank, commas, end, open + 1)).toEqual([
      "a",
      "pick(b, c)",
      "d",
    ]);
    expect(blank[end]).toBe(")");
  });

  test("stops at the closer when asked", () => {
    const blank = "f(a) + g(b), after";
    const open = 1;
    const { commas, end } = topLevelCommas(blank, callShape(open));

    expect(commas).toEqual([]);
    expect(blank[end]).toBe(")");
  });

  test("runs to the text's end when nothing closes it", () => {
    const blank = "f(a, b";
    const open = 1;
    const { commas, end } = topLevelCommas(blank, callShape(open));

    expect(pieces(blank, commas, end, open + 1)).toEqual(["a", "b"]);
    expect(end).toBe(blank.length);
  });

  test("reports UTF-16 code-unit indexes for astral characters", () => {
    // An emoji is two code units. Indexes that count code points would
    // slice into the middle of it and shift every later piece.
    const clause = "note = \u{1F600}, quantity = 1";
    const { commas, end } = topLevelCommas(clause, sqlShape());

    expect(pieces(clause, commas, end)).toEqual([
      "note = \u{1F600}",
      "quantity = 1",
    ]);
  });

  test("reads past brackets a quoted value carries, when never stopped", () => {
    // The SQL shape must not stop at a closer inside the text: a value
    // like ')(' would otherwise swallow every later assignment.
    const clause = "note = ')(', quantity = 1";
    const { commas, end } = topLevelCommas(clause, sqlShape());

    expect(pieces(clause, commas, end)).toEqual([
      "note = ')('",
      "quantity = 1",
    ]);
  });
});
