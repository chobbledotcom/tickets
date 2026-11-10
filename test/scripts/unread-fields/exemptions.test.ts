import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseExemptionRules,
  UNREAD_FIELD_EXEMPTION_RULES,
} from "#scripts/unread-fields/exemptions.ts";
import { ownerKey } from "#scripts/unread-fields/identity.ts";

const rule = {
  evidence: "the route reads each field by key",
  kind: "dynamic-read",
  path: [{ name: "Body" }],
};

const manifest = { "src/shared/api.ts": [rule] };

describe("unread-field rule manifest", () => {
  test("reads one rule into its file, owner path, and reason", () => {
    expect(parseExemptionRules(manifest)).toEqual([
      {
        exportedFrom: "src/shared/api.ts",
        path: [{ name: "Body" }],
        reason: {
          evidence: "the route reads each field by key",
          kind: "dynamic-read",
        },
      },
    ]);
  });

  test("keeps a way step apart from a name it shares", () => {
    expect(
      parseExemptionRules({
        "src/shared/api.ts": [
          { ...rule, path: [{ way: "[]" }, { name: "[]" }] },
        ],
      })[0]!.path,
    ).toEqual([{ way: "[]" }, { name: "[]" }]);
  });

  // A manifest entry the gate cannot read back is an error at its own place.
  const malformed: [string, unknown, string][] = [
    [
      "a rule with no owner path step",
      { "src/shared/api.ts": [{ ...rule, path: [] }] },
      "src/shared/api.ts / 0 / path: A rule must name at least one owner path step",
    ],
    [
      "a leftover field name, which would widen the rule",
      { "src/shared/api.ts": [{ ...rule, field: "total" }] },
      'src/shared/api.ts / 0 / field: Invalid key: Expected never but received "field"',
    ],
    [
      "evidence that names nothing",
      { "src/shared/api.ts": [{ ...rule, evidence: "   " }] },
      "src/shared/api.ts / 0 / evidence: A rule must name the production evidence that the scan misses",
    ],
    [
      "a file outside src/",
      { "./src/shared/api.ts": [rule] },
      "./src/shared/api.ts: A rule file must be a path under src/",
    ],
    [
      "a mechanism outside the five",
      { "src/shared/api.ts": [{ ...rule, kind: "guessed" }] },
      "src/shared/api.ts / 0 / kind: Invalid type",
    ],
    [
      "a step that carries a name and a way at once",
      {
        "src/shared/api.ts": [{ ...rule, path: [{ name: "Body", way: "[]" }] }],
      },
      "src/shared/api.ts / 0 / path / 0: A step must name a field or the way a reader reaches through it",
    ],
    [
      "a file entry with no rule",
      { "src/shared/api.ts": [] },
      "src/shared/api.ts: A file must name at least one rule",
    ],
  ];

  for (const [name, bad, message] of malformed) {
    test(`refuses ${name}`, () => {
      expect(() => parseExemptionRules(bad)).toThrow(message);
    });
  }

  test("names each owner path once, so no field gains two reasons", () => {
    const keys = UNREAD_FIELD_EXEMPTION_RULES.map((rule) =>
      ownerKey(rule.exportedFrom, rule.path),
    );

    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
