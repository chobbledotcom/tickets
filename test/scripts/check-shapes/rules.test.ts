import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  formatMatch,
  matchKey,
  outsideSharedMechanism,
  type ShapeSite,
  shapeMatches,
} from "#scripts/check-shapes/rules.ts";
import { shapeOf } from "#scripts/check-shapes/shape.ts";

const site = (name: string, body: string, file = "src/a.ts"): ShapeSite => ({
  body,
  file,
  line: 1,
  masked: body,
  name,
});

const LONG_A = "(a) => a.one().two().three().four().five().six().seven()";
const LONG_B = "(v) => v.one().two().three().four().five().six().seven()";
const LONG_C = "(w) => w.one().two().three().four().five().six().eight(9)";

describe("matchKey", () => {
  test("names every site, sorted, so moving code does not change it", () => {
    const sites = [site("b", LONG_A, "src/z.ts"), site("a", LONG_A)];
    expect(matchKey(sites)).toBe("src/a.ts::a,src/z.ts::b");
  });

  test("gives the same key whatever order the sites arrive in", () => {
    const one = site("a", LONG_A);
    const two = site("b", LONG_B, "src/z.ts");
    expect(matchKey([one, two])).toBe(matchKey([two, one]));
  });
});

describe("shapeMatches", () => {
  test("groups two bodies that differ only in their names", () => {
    const matches = shapeMatches(
      [site("a", LONG_A), site("b", LONG_B)],
      shapeOf,
      10,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.sites.map((found) => found.name)).toEqual(["a", "b"]);
  });

  test("counts the shape's tokens, not the body's characters", () => {
    const matches = shapeMatches(
      [site("a", LONG_A), site("b", LONG_B)],
      shapeOf,
      10,
    );
    expect(matches[0]?.tokens).toBe(shapeOf(LONG_A).length);
  });

  test("leaves a body shorter than the minimum alone", () => {
    expect(
      shapeMatches([site("a", "a + 1"), site("b", "b + 2")], shapeOf, 10),
    ).toEqual([]);
  });

  test("leaves two bodies written the same way to jscpd", () => {
    expect(
      shapeMatches([site("a", LONG_A), site("b", LONG_A)], shapeOf, 10),
    ).toEqual([]);
  });

  test("still reports a group where only one pair was written alike", () => {
    const matches = shapeMatches(
      [site("a", LONG_A), site("b", LONG_A), site("c", LONG_B)],
      shapeOf,
      10,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.sites).toHaveLength(3);
  });

  test("leaves a body nothing else matches alone", () => {
    expect(
      shapeMatches([site("a", LONG_A), site("c", LONG_C)], shapeOf, 10),
    ).toEqual([]);
  });

  test("returns groups in key order, so the report is stable", () => {
    const matches = shapeMatches(
      [
        site("z", LONG_A, "src/z.ts"),
        site("y", LONG_B, "src/z.ts"),
        site("b", LONG_C, "src/a.ts"),
        site(
          "a",
          LONG_C.replace("(w)", "(q)").replaceAll("w.", "q."),
          "src/a.ts",
        ),
      ],
      shapeOf,
      10,
    );
    expect(matches.map((match) => match.key)).toEqual([
      "src/a.ts::a,src/a.ts::b",
      "src/z.ts::y,src/z.ts::z",
    ]);
  });
});

describe("formatMatch", () => {
  test("says how many share the shape, then where each one is", () => {
    const matches = shapeMatches(
      [site("a", LONG_A), site("b", LONG_B, "src/z.ts")],
      shapeOf,
      10,
    );
    expect(formatMatch(matches[0] as never)).toBe(
      [
        `2 functions share one shape (${shapeOf(LONG_A).length} tokens):`,
        "    src/a.ts:1  a",
        "    src/z.ts:1  b",
      ].join("\n"),
    );
  });
});

describe("outsideSharedMechanism", () => {
  const inFp = (file: string) => file === "src/fp.ts";
  const group = (...sites: ShapeSite[]) => ({ key: "k", sites, tokens: 30 });

  test("drops a group whose every site is the shared mechanism", () => {
    const only = group(
      site("map", LONG_A, "src/fp.ts"),
      site("filter", LONG_B, "src/fp.ts"),
    );
    expect(outsideSharedMechanism(inFp)([only])).toEqual([]);
  });

  test("keeps a group where one site copies the shared mechanism", () => {
    const mixed = group(
      site("map", LONG_A, "src/fp.ts"),
      site("mapAgain", LONG_B, "src/elsewhere.ts"),
    );
    expect(outsideSharedMechanism(inFp)([mixed])).toEqual([mixed]);
  });

  test("keeps a group that never touches the shared mechanism", () => {
    const plain = group(site("a", LONG_A), site("b", LONG_B, "src/z.ts"));
    expect(outsideSharedMechanism(inFp)([plain])).toEqual([plain]);
  });
});
