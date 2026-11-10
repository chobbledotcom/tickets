import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseExemptionRules,
  UNREAD_FIELD_EXEMPTION_RULES,
} from "#scripts/unread-fields/exemptions.ts";
import { ownerKey } from "#scripts/unread-fields/identity.ts";
import { testRefusedEntries } from "#test-utils/unread-field-policy.ts";

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

  // A rule the gate cannot read back is an error at its own place.
  testRefusedEntries(parseExemptionRules, rule, [
    [
      "a rule with no owner path step",
      { path: [] },
      "path: A rule must name at least one owner path step",
    ],
    [
      "a leftover field name, which would widen the rule",
      { field: "total" },
      'field: Invalid key: Expected never but received "field"',
    ],
    [
      "evidence that names nothing",
      { evidence: "   " },
      "evidence: A rule must name the production evidence that the scan misses",
    ],
    ["a mechanism outside the five", { kind: "guessed" }, "kind: Invalid type"],
  ]);

  test("names each owner path once, so no field gains two reasons", () => {
    const keys = UNREAD_FIELD_EXEMPTION_RULES.map((rule) =>
      ownerKey(rule.exportedFrom, rule.path),
    );

    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
