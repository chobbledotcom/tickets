import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { maskSpans } from "#scripts/check-shapes/mask-spans.ts";
import { shapeOf } from "#scripts/typescript-lex.ts";

describe("maskSpans", () => {
  /** Masks the whole of `source`, given each run and what stands for it. Each
   * run is found after the one before it, so a repeated run still lands where
   * it was written. */
  const maskAll = (source: string, ...runs: [string, string][]): string => {
    let cursor = 0;
    const spans = runs.map(([run, as]) => {
      const start = source.indexOf(run, cursor);
      cursor = start + run.length;
      return { as, end: cursor, start };
    });
    return maskSpans(source, { end: source.length, start: 0 }, spans);
  };

  test("puts what stands for a run in its place", () => {
    expect(maskAll("<b>Save changes</b>", ["Save changes", '""'])).toBe(
      '<b>""</b>',
    );
  });

  test("takes a run away when nothing stands for it", () => {
    expect(maskAll("<p>\n  <b/>\n</p>", ["\n  ", ""], ["\n", ""])).toBe(
      "<p><b/></p>",
    );
  });

  test("leaves a body with no runs exactly as it was", () => {
    expect(maskAll("(a) => a + 1")).toBe("(a) => a + 1");
  });

  test("ignores a run outside the body it is asked for", () => {
    const source = "<b>one</b><i>two</i>";
    const runs = [
      { as: '""', end: 6, start: 3 },
      { as: '""', end: 17, start: 14 },
    ];
    expect(maskSpans(source, { end: 10, start: 0 }, runs)).toBe('<b>""</b>');
  });

  test("gives two components that differ only in wording one shape", () => {
    const first = maskAll("<b>Yes please</b>", ["Yes please", '""']);
    const second = maskAll("<b>No thanks</b>", ["No thanks", '""']);
    expect(shapeOf(first)).toEqual(shapeOf(second));
  });
});
