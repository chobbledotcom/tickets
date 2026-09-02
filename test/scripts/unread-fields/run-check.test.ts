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
      exemptions: [],
      scan: () => Promise.resolve([finding]),
    });

    expect(code).toBe(0);
    expect(seen.lines).toEqual([
      "Every reported unread field matches one exact policy entry, and every policy entry is current.",
    ]);
    expect(seen.errors).toEqual([]);
  });

  test("reports every reconciliation problem and returns failure", async () => {
    const seen = output();
    const code = await runUnreadFieldsCheck("/repo", seen.value, {
      baseline: [],
      exemptions: [],
      scan: () => Promise.resolve([finding]),
    });

    expect(code).toBe(1);
    expect(seen.errors[0]).toContain("new unread field [never read]");
    expect(seen.errors.at(-1)).toBe(
      "\n1 unread-field issue(s) found. See scripts/unread-fields/README.md.",
    );
  });

  test("lets scan failures propagate", async () => {
    const failure = new Error("scan failed");

    await expect(
      runUnreadFieldsCheck("/repo", output().value, {
        baseline: [],
        exemptions: [],
        scan: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
  });
});
