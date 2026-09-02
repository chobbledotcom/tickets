import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type ClosedFieldSnapshot,
  exemptFieldsAt,
} from "#scripts/unread-fields/policy.ts";

type Sample = { kept: string; optional?: number };

const reason = {
  evidence: "sendSample serialises the complete value",
  kind: "external-output",
} as const;

describe("unread-field policy", () => {
  test("requires optional fields in a closed snapshot", () => {
    const complete: ClosedFieldSnapshot<Sample> = {
      kept: "check",
      optional: "exempt",
    };
    expect(complete.optional).toBe("exempt");

    // @ts-expect-error A closed snapshot must classify every optional field.
    const missing: ClosedFieldSnapshot<Sample> = { kept: "check" };
    expect(missing.kept).toBe("check");
  });

  test("refuses an open string-key type", () => {
    // @ts-expect-error An open key domain cannot be a closed snapshot.
    const open: ClosedFieldSnapshot<Record<string, string>> = {};
    expect(open).toEqual({});
  });

  test("emits only fields marked exempt", () => {
    const exemptions = exemptFieldsAt<Sample>(
      "src/sample.ts",
      [{ name: "Sample" }],
      reason,
    )({ kept: "check", optional: "exempt" });

    expect(exemptions).toEqual([
      {
        identity: {
          exportedFrom: "src/sample.ts",
          field: "optional",
          path: [{ name: "Sample" }],
        },
        reason,
      },
    ]);
  });
});
