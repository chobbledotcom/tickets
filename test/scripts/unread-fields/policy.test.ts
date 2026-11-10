import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { FindingIdentity } from "#scripts/unread-fields/identity.ts";
import {
  type ExemptionRule,
  exemptionsOf,
  reasonFor,
} from "#scripts/unread-fields/policy.ts";

const reason = reasonFor("external-output")(
  "sendSample serialises the complete value",
);

const reported: readonly FindingIdentity[] = [
  { exportedFrom: "src/sample.ts", field: "kept", path: [{ name: "Sample" }] },
  {
    exportedFrom: "src/sample.ts",
    field: "nested",
    path: [{ name: "Sample" }, { name: "inner" }],
  },
  { exportedFrom: "src/other.ts", field: "kept", path: [{ name: "Sample" }] },
];

describe("unread-field policy", () => {
  test("builds a reason of one kind", () => {
    expect(reason).toEqual({
      evidence: "sendSample serialises the complete value",
      kind: "external-output",
    });
  });

  test("covers only the reported fields under the rule's exact owner path", () => {
    const rule: ExemptionRule = {
      exportedFrom: "src/sample.ts",
      path: [{ name: "Sample" }],
      reason,
    };

    expect(exemptionsOf(reported)(rule)).toEqual([
      {
        identity: {
          exportedFrom: "src/sample.ts",
          field: "kept",
          path: [{ name: "Sample" }],
        },
        reason,
      },
    ]);
  });

  test("covers nothing when the rule's owner holds no reported field", () => {
    expect(
      exemptionsOf(reported)({
        exportedFrom: "src/sample.ts",
        path: [{ name: "Absent" }],
        reason,
      }),
    ).toEqual([]);
  });
});
