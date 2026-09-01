import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bodyFingerprint,
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
  sharedMechanism: file === "src/fp.ts",
});

const LONG_A = "(a) => a.one().two().three().four().five().six().seven()";
const LONG_B = "(v) => v.one().two().three().four().five().six().seven()";
const LONG_C = "(w) => w.one().two().three().four().five().six().eight(9)";

describe("bodyFingerprint", () => {
  test("changes when the body's text changes", () => {
    expect(bodyFingerprint("total() + 1")).not.toBe(
      bodyFingerprint("total() + 2"),
    );
  });

  test("stays put when only nesting depth re-indents the body", () => {
    expect(bodyFingerprint("if (a) {\n  b();\n}")).toBe(
      bodyFingerprint("if (a) {\n      b();\n      }"),
    );
  });

  test("drops blank lines, so a spacer changes nothing", () => {
    expect(bodyFingerprint("one();\n\ntwo();")).toBe(
      bodyFingerprint("one();\ntwo();"),
    );
  });

  test("reads a line break as different code from a space, because ASI is real", () => {
    expect(bodyFingerprint("one()\ntwo()")).not.toBe(
      bodyFingerprint("one() two()"),
    );
  });

  test("reads where a line breaks as part of the code, not only that it does", () => {
    expect(bodyFingerprint("run(x)")).not.toBe(bodyFingerprint("run\n(x)"));
  });

  test("keeps the spaces inside a line, which no split may drop", () => {
    expect(bodyFingerprint("a + b")).not.toBe(bodyFingerprint("a\n b"));
  });

  test("reads a template's own whitespace as data, not as layout", () => {
    expect(bodyFingerprint("return `a\n b`")).not.toBe(
      bodyFingerprint("return `a\nb`"),
    );
    // Re-indenting the code around it still changes nothing.
    expect(bodyFingerprint("return `a\n b`")).toBe(
      bodyFingerprint("  return `a\n b`"),
    );
  });
});

describe("matchKey", () => {
  test("names every site, sorted, each with its fingerprint", () => {
    const sites = [site("b", LONG_A, "src/z.ts"), site("a", LONG_A)];
    expect(matchKey(sites)).toBe(
      `src/a.ts::a~${bodyFingerprint(LONG_A)},src/z.ts::b~${bodyFingerprint(
        LONG_A,
      )}`,
    );
  });

  test("gives the same key whatever order the sites arrive in", () => {
    const one = site("a", LONG_A);
    const two = site("b", LONG_B, "src/z.ts");
    expect(matchKey([one, two])).toBe(matchKey([two, one]));
  });

  test("changes when one listed body is edited, even though the shape holds", () => {
    const edited = LONG_A.replace("seven()", "seventh()");
    expect(matchKey([site("a", LONG_A)])).not.toBe(
      matchKey([site("a", edited)]),
    );
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

  test("leaves a lone shared-mechanism body alone too", () => {
    expect(
      shapeMatches([site("map", LONG_A, "src/fp.ts")], shapeOf, 10),
    ).toEqual([]);
  });

  test("keeps unary plus apart from increment, whose tokens join alike", () => {
    const plus = "one() + +two().three().four().five()";
    const step = "one() ++ two().three().four().five()";
    expect(
      shapeMatches([site("a", plus), site("b", step)], shapeOf, 10),
    ).toEqual([]);
  });

  test("returns groups in key order, so the report is stable", () => {
    const renamed = LONG_C.replace("(w)", "(q)").replaceAll("w.", "q.");
    const matches = shapeMatches(
      [
        site("z", LONG_A, "src/z.ts"),
        site("y", LONG_B, "src/z.ts"),
        site("b", LONG_C, "src/a.ts"),
        site("a", renamed, "src/a.ts"),
      ],
      shapeOf,
      10,
    );
    expect(matches.map((match) => match.key)).toEqual([
      `src/a.ts::a~${bodyFingerprint(renamed)},src/a.ts::b~${bodyFingerprint(
        LONG_C,
      )}`,
      `src/z.ts::y~${bodyFingerprint(LONG_B)},src/z.ts::z~${bodyFingerprint(
        LONG_A,
      )}`,
    ]);
  });
});

describe("formatMatch", () => {
  test("says how many share the shape, where each one is, and the line to accept", () => {
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
        `    to accept: src/a.ts::a~${bodyFingerprint(LONG_A)},src/z.ts::b~${bodyFingerprint(
          LONG_B,
        )}  # why it stands`,
      ].join("\n"),
    );
  });
});

describe("outsideSharedMechanism", () => {
  const group = (...sites: ShapeSite[]) => ({ key: "k", sites, tokens: 30 });

  test("drops a group whose every site is the shared mechanism", () => {
    const only = group(
      site("map", LONG_A, "src/fp.ts"),
      site("filter", LONG_B, "src/fp.ts"),
    );
    expect(outsideSharedMechanism([only])).toEqual([]);
  });

  test("keeps a group where one site copies the shared mechanism", () => {
    const mixed = group(
      site("map", LONG_A, "src/fp.ts"),
      site("mapAgain", LONG_B, "src/elsewhere.ts"),
    );
    expect(outsideSharedMechanism([mixed])).toEqual([mixed]);
  });

  test("keeps a group that never touches the shared mechanism", () => {
    const plain = group(site("a", LONG_A), site("b", LONG_B, "src/z.ts"));
    expect(outsideSharedMechanism([plain])).toEqual([plain]);
  });
});

describe("shapeMatches leaving exact copies to deno task cpd", () => {
  test("skips a pair of byte-identical bodies, which cpd reports", () => {
    const twins = [site("a", LONG_A), site("b", LONG_A, "src/z.ts")];
    expect(shapeMatches(twins, shapeOf, 20)).toEqual([]);
  });

  test("reports an exact copy of an #fp helper, which cpd never reads", () => {
    const copied = [
      site("map", LONG_A, "src/fp.ts"),
      site("mapAgain", LONG_A, "src/z.ts"),
    ];
    expect(shapeMatches(copied, shapeOf, 20)).toHaveLength(1);
  });
});
