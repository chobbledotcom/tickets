import { uniqueBy } from "#fp";
import type { Finding } from "#scripts/unread-fields/findings.ts";
import {
  compareText,
  type FindingIdentity,
  findingIdentityKey,
  findingIdentityText,
  ownerPath,
} from "#scripts/unread-fields/identity.ts";
import {
  type ExemptionReason,
  type ExemptionRule,
  exemptionsOf,
} from "#scripts/unread-fields/policy.ts";

type ProblemKind =
  | "duplicate finding"
  | "duplicate baseline"
  | "duplicate exemption"
  | "stale baseline"
  | "stale rule"
  | "new unread field";

type PlainProblemKind = Exclude<ProblemKind, "stale rule" | "new unread field">;

interface PlainProblem {
  identity: FindingIdentity;
  kind: PlainProblemKind;
}

interface StaleRuleProblem {
  kind: "stale rule";
  owner: string;
  reason: ExemptionReason;
}

interface NewUnreadFieldProblem {
  file: string;
  identity: FindingIdentity;
  kind: "new unread field";
  verdict: Finding["verdict"];
}

export type UnreadFieldProblem =
  | PlainProblem
  | StaleRuleProblem
  | NewUnreadFieldProblem;

const KIND_ORDER: Record<ProblemKind, number> = {
  "duplicate baseline": 1,
  "duplicate exemption": 2,
  "duplicate finding": 0,
  "new unread field": 5,
  "stale baseline": 3,
  "stale rule": 4,
};

const duplicateIdentities = <Item>(
  items: readonly Item[],
  identityOf: (item: Item) => FindingIdentity,
): FindingIdentity[] =>
  [
    ...Map.groupBy(items, (item) =>
      findingIdentityKey(identityOf(item)),
    ).values(),
  ]
    .filter((same) => same.length > 1)
    .map(([first]) => identityOf(first!));

const uniqueIdentities = (
  identities: readonly FindingIdentity[],
): FindingIdentity[] => uniqueBy(findingIdentityKey)([...identities]);

const problem = (
  kind: PlainProblemKind,
  identity: FindingIdentity,
): PlainProblem => ({ identity, kind });

/** The owner a stale rule names, for a reader who has to repair it. */
const ruleOwnerText = (rule: ExemptionRule): string =>
  `${rule.exportedFrom} :: ${ownerPath(rule.path)}`;

/** The stable text a problem sorts and reads by. */
const problemKey = (problem: UnreadFieldProblem): string =>
  problem.kind === "stale rule"
    ? problem.owner
    : findingIdentityKey(problem.identity);

/** Compare the current report with accepted debt and reviewed false positives.
 *  Every exemption is generated from a rule and the report, so a rule that
 *  covers no reported field is stale. */
export const reconcileUnreadFields =
  (baseline: readonly FindingIdentity[], rules: readonly ExemptionRule[]) =>
  (findings: readonly Finding[]) => {
    const unread = findings.filter(({ verdict }) => verdict !== "read");
    const currentKeys = new Set(unread.map(findingIdentityKey));
    const baselineKeys = new Set(baseline.map(findingIdentityKey));
    // The baseline is the stronger record. A field it holds stays accepted
    // debt, so a rule never hides debt behind a reviewed false positive.
    const reported = unread.filter(
      (finding) => !baselineKeys.has(findingIdentityKey(finding)),
    );
    const covered = rules.map((rule) => ({
      exemptions: exemptionsOf(reported)(rule),
      rule,
    }));
    const exemptions = covered.flatMap((covered) => covered.exemptions);
    const exemptionKeys = new Set(
      exemptions.map(({ identity }) => findingIdentityKey(identity)),
    );
    const problems: UnreadFieldProblem[] = [
      ...duplicateIdentities(baseline, (identity) => identity).map((identity) =>
        problem("duplicate baseline", identity),
      ),
      ...duplicateIdentities(findings, (finding) => finding).map((identity) =>
        problem("duplicate finding", identity),
      ),
      ...duplicateIdentities(exemptions, ({ identity }) => identity).map(
        (identity) => problem("duplicate exemption", identity),
      ),
      ...uniqueIdentities(baseline)
        .filter((identity) => !currentKeys.has(findingIdentityKey(identity)))
        .map((identity) => problem("stale baseline", identity)),
      ...covered
        .filter(({ exemptions }) => exemptions.length === 0)
        .map(({ rule }) => ({
          kind: "stale rule" as const,
          owner: ruleOwnerText(rule),
          reason: rule.reason,
        })),
      ...unread
        .filter((finding) => {
          const key = findingIdentityKey(finding);
          return !baselineKeys.has(key) && !exemptionKeys.has(key);
        })
        .map((finding) => ({
          file: finding.file,
          identity: finding,
          kind: "new unread field" as const,
          verdict: finding.verdict,
        })),
    ];
    return problems.toSorted(
      (left, right) =>
        KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
        compareText(problemKey(left), problemKey(right)),
    );
  };

/** One policy problem with enough identity and evidence to repair it. */
export const formatUnreadFieldProblem = (
  problem: UnreadFieldProblem,
): string => {
  if (problem.kind === "new unread field") {
    return `${problem.kind} [${problem.verdict}]: ${findingIdentityText(problem.identity)} -- declared in ${problem.file}`;
  }
  if (problem.kind === "stale rule") {
    return `${problem.kind}: ${problem.owner} -- ${problem.reason.kind}: ${problem.reason.evidence}`;
  }
  return `${problem.kind}: ${findingIdentityText(problem.identity)}`;
};
