import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { CheckOutput } from "#scripts/check-report.ts";
import type { Finding } from "#scripts/unread-fields/findings.ts";
import { runUnreadFieldsCheck } from "#scripts/unread-fields/run-check.ts";

const finding: Finding = {
  exportedFrom: "src/sum.ts",
  field: "total",
  file: "src/sum.ts",
  owner: "Sum",
  path: [{ name: "Sum" }],
  verdict: "never read",
};

const output = (): {
  errors: string[];
  lines: string[];
  value: CheckOutput;
} => {
  const errors: string[] = [];
  const lines: string[] = [];
  return {
    errors,
    lines,
    value: {
      log: (line) => lines.push(line),
      logError: (line) => errors.push(line),
    },
  };
};

describe("unread-field check", () => {
  test("reports success when every finding has exact policy", async () => {
    const seen = output();
    const code = await runUnreadFieldsCheck("/repo", seen.value, {
      baseline: [finding],
      rules: [],
      scan: () => Promise.resolve([finding]),
    });

    expect({ code, errors: seen.errors, lines: seen.lines }).toEqual({
      code: 0,
      errors: [],
      lines: [
        "Every reported unread field is accepted debt or sits under a current exemption rule.",
      ],
    });
  });

  test("reports every reconciliation problem and returns failure", async () => {
    const seen = output();
    const code = await runUnreadFieldsCheck("/repo", seen.value, {
      baseline: [],
      rules: [],
      scan: () => Promise.resolve([finding]),
    });

    expect(code).toBe(1);
    assertStringIncludes(seen.errors[0] ?? "", "new unread field [never read]");
    expect(seen.errors.at(-1)).toBe(
      "\n1 unread-field issue(s) found. See scripts/unread-fields/README.md.",
    );
  });

  test("lets scan failures propagate", async () => {
    const failure = new Error("scan failed");

    await expect(
      runUnreadFieldsCheck("/repo", output().value, {
        baseline: [],
        rules: [],
        scan: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
  });
});
