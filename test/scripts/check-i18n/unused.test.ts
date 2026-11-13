import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  keyReferences,
  unreferencedKeys,
  unusedKeyFindings,
} from "#scripts/check-i18n/unused.ts";

const dollar = String.fromCodePoint(36);

/** One scan: the source lines, the catalog keys, and the keys left with no
 *  reference. */
type ScanCase = {
  keys: readonly string[];
  name: string;
  source: readonly string[];
  unreferenced: readonly string[];
};

const SCAN_CASES: readonly ScanCase[] = [
  {
    keys: ["a.one", "a.two", "a.three", "a.four"],
    name: "a key spelled out in any quote style has a reference",
    source: ["t(\"a.one\"); translated('a.two'); header: `a.three`"],
    unreferenced: ["a.four"],
  },
  {
    keys: [
      "kinds.calc.fixed",
      "kinds.calc.deep.percent",
      "rows.first",
      "kinds.other",
    ],
    name: "a quoted parent refers to every key beneath it",
    source: ['options(Schema, "kinds.calc"); prefix("rows.")'],
    unreferenced: ["kinds.other"],
  },
  {
    keys: ["terms.holiday", "terms"],
    name: "a bare word is no parent",
    source: ['subpath: "terms"'],
    unreferenced: ["terms.holiday"],
  },
  {
    keys: [
      "schema.row.intro",
      "schema.row.state.free",
      "holidays.heading",
      "schema.row.outro",
      "holidays.title",
    ],
    name: "a template refers to the keys it fits and to keys beneath them",
    source: [
      `label: \`schema.${dollar}{id}.intro\``,
      `states(\`schema.${dollar}{id}.state\`)`,
      `t(\`${dollar}{area}.heading\`)`,
    ],
    unreferenced: ["schema.row.outro", "holidays.title"],
  },
  {
    keys: ["page.title", "a.b"],
    name: "a template that cannot build a key refers to nothing",
    source: [
      `\`${dollar}{a}.${dollar}{b}\``,
      `\`Hello ${dollar}{name}.title\``,
      `\`${dollar}{count}title\``,
    ],
    unreferenced: ["page.title", "a.b"],
  },
];

describe("unreferencedKeys", () => {
  for (const scan of SCAN_CASES) {
    test(scan.name, () => {
      expect(
        unreferencedKeys(scan.keys, keyReferences([scan.source.join("\n")])),
      ).toEqual(scan.unreferenced);
    });
  }
});

describe("unusedKeyFindings", () => {
  test("names a new unused key and a recorded key that no longer applies", () => {
    expect(
      unusedKeyFindings(["a.dead", "a.new"], ["a.dead", "a.used"]),
    ).toEqual({ added: ["a.new"], stale: ["a.used"] });
  });
});
