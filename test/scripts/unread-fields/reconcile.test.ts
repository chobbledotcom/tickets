import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Finding } from "#scripts/unread-fields/findings.ts";
import type { FindingIdentity } from "#scripts/unread-fields/identity.ts";
import type { FindingExemption } from "#scripts/unread-fields/policy.ts";
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

const exemption = (field = "total"): FindingExemption => ({
  identity: identity(field),
  reason: {
    evidence: "sendSum serialises the complete value",
    kind: "external-output",
  },
});

const kindsOf = (
  findings: readonly Finding[],
  baseline: readonly FindingIdentity[] = [],
  exemptions: readonly FindingExemption[] = [],
): string[] =>
  reconcileUnreadFields(baseline, exemptions)(findings).map(({ kind }) => kind);

describe("unread-field reconciliation", () => {
  test("accepts exact baseline debt and reviewed exemptions", () => {
    expect(
      kindsOf(
        [finding(), finding("external")],
        [identity()],
        [exemption("external")],
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
      kindsOf(
        [finding("baseline", "read"), finding("exemption", "read")],
        [identity("baseline")],
        [exemption("exemption")],
      ),
    ).toEqual(["stale baseline", "stale exemption"]);
  });

  test("reports duplicates and policy overlap without hiding other problems", () => {
    expect(
      kindsOf(
        [finding(), finding()],
        [identity(), identity()],
        [exemption(), exemption()],
      ),
    ).toEqual([
      "duplicate finding",
      "duplicate baseline",
      "duplicate exemption",
      "policy overlap",
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
      [],
    )([finding("b"), finding("a")]);

    expect(
      problems.map(({ kind, identity }) => `${kind}:${identity.field}`),
    ).toEqual(["stale baseline:z", "new unread field:a", "new unread field:b"]);
  });

  test("formats enough evidence to repair a new field", () => {
    const [problem] = reconcileUnreadFields([], [])([finding()]);

    expect(formatUnreadFieldProblem(problem!)).toBe(
      'new unread field [never read]: src/sum.ts :: name("Sum") / name("total")' +
        " -- declared in src/sum.ts",
    );
  });

  test("keeps the exemption reason in a stale diagnostic", () => {
    const [problem] = reconcileUnreadFields([], [exemption()])([]);

    expect(formatUnreadFieldProblem(problem!)).toContain(
      "external-output: sendSum serialises the complete value",
    );
  });

  test("formats a plain policy problem", () => {
    const [problem] = reconcileUnreadFields([identity()], [])([]);

    expect(formatUnreadFieldProblem(problem!)).toBe(
      'stale baseline: src/sum.ts :: name("Sum") / name("total")',
    );
  });
});
