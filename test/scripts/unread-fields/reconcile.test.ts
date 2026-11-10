import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Finding } from "#scripts/unread-fields/findings.ts";
import type { FindingIdentity } from "#scripts/unread-fields/identity.ts";
import type { ExemptionRule } from "#scripts/unread-fields/policy.ts";
import {
  formatUnreadFieldProblem,
  reconcileUnreadFields,
} from "#scripts/unread-fields/reconcile.ts";

const identity = (field = "total"): FindingIdentity => ({
  exportedFrom: "src/sum.ts",
  field,
  path: [{ name: "Sum" }],
});

const finding = (
  field = "total",
  verdict: Finding["verdict"] = "never read",
): Finding => ({
  ...identity(field),
  file: "src/sum.ts",
  owner: "Sum",
  verdict,
});

const rule = (
  path: FindingIdentity["path"] = [{ name: "Sum" }],
): ExemptionRule => ({
  exportedFrom: "src/sum.ts",
  path,
  reason: {
    evidence: "sendSum serialises the complete value",
    kind: "external-output",
  },
});

const kindsOf = (
  findings: readonly Finding[],
  baseline: readonly FindingIdentity[] = [],
  rules: readonly ExemptionRule[] = [],
): string[] =>
  reconcileUnreadFields(baseline, rules)(findings).map(({ kind }) => kind);

describe("unread-field reconciliation", () => {
  test("accepts exact baseline debt and a current rule", () => {
    expect(
      kindsOf(
        [finding(), finding("external")],
        [identity()],
        [rule([{ name: "Sum" }])],
      ),
    ).toEqual([]);
  });

  test("rejects both kinds of new unread field", () => {
    expect(
      kindsOf([
        finding("none"),
        finding("tests", "read only by tests"),
        finding("used", "read"),
      ]),
    ).toEqual(["new unread field", "new unread field"]);
  });

  test("calls a removed or newly read entry stale", () => {
    expect(
      kindsOf([finding("baseline", "read")], [identity("baseline")]),
    ).toEqual(["stale baseline"]);
    expect(kindsOf([finding("read", "read")], [], [rule()])).toEqual([
      "stale rule",
    ]);
  });

  test("lets baseline debt win over a rule on the same owner", () => {
    expect(kindsOf([finding()], [identity()], [rule()])).toEqual([
      "stale rule",
    ]);
  });

  test("reports duplicate findings and baseline entries", () => {
    expect(kindsOf([finding(), finding()], [identity(), identity()])).toEqual([
      "duplicate finding",
      "duplicate baseline",
    ]);
  });

  test("reports one duplicate exemption for two rules on one owner", () => {
    expect(kindsOf([finding("external")], [], [rule(), rule()])).toEqual([
      "duplicate exemption",
    ]);
  });

  test("reports one stale problem for a duplicated absent entry", () => {
    expect(kindsOf([], [identity(), identity()])).toEqual([
      "duplicate baseline",
      "stale baseline",
    ]);
  });

  test("sorts problem kinds before exact identities", () => {
    const problems = reconcileUnreadFields(
      [identity("z")],
      [{ ...rule(), path: [{ name: "Absent" }] }],
    )([finding("b"), finding("a")]);

    expect(
      problems.map((problem) =>
        problem.kind === "stale rule"
          ? problem.kind
          : `${problem.kind}:${problem.identity.field}`,
      ),
    ).toEqual([
      "stale baseline:z",
      "stale rule",
      "new unread field:a",
      "new unread field:b",
    ]);
  });

  test("sorts two stale rules by the owner they name", () => {
    const problems = reconcileUnreadFields(
      [],
      [rule([{ name: "Zed" }]), rule([{ name: "Alpha" }])],
    )([]);

    expect(
      problems.map((problem) =>
        problem.kind === "stale rule" ? problem.owner : problem.kind,
      ),
    ).toEqual(["src/sum.ts :: Alpha", "src/sum.ts :: Zed"]);
  });

  test("formats enough evidence to repair a new field", () => {
    const [problem] = reconcileUnreadFields([], [])([finding()]);

    expect(formatUnreadFieldProblem(problem!)).toBe(
      'new unread field [never read]: src/sum.ts :: name("Sum") / name("total")' +
        " -- declared in src/sum.ts",
    );
  });

  test("keeps the rule's reason in a stale diagnostic", () => {
    const [problem] = reconcileUnreadFields([], [rule()])([]);

    expect(formatUnreadFieldProblem(problem!)).toBe(
      "stale rule: src/sum.ts :: Sum -- external-output: sendSum serialises the complete value",
    );
  });

  test("formats a plain policy problem", () => {
    const [problem] = reconcileUnreadFields([identity()], [])([]);

    expect(formatUnreadFieldProblem(problem!)).toBe(
      'stale baseline: src/sum.ts :: name("Sum") / name("total")',
    );
  });

  test("names the readable path of a nested stale rule", () => {
    const [problem] = reconcileUnreadFields(
      [],
      [rule([{ name: "Sum" }, { name: "inner" }, { way: "[]" }])],
    )([]);

    assertStringIncludes(formatUnreadFieldProblem(problem!), 'Sum.inner["[]"]');
  });
});
