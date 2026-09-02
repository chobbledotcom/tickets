import { uniqueBy } from "#fp";
import type { Finding } from "#scripts/unread-fields/findings.ts";
import {
  compareFindingIdentities,
  type FindingIdentity,
  findingIdentityKey,
  findingIdentityText,
} from "#scripts/unread-fields/identity.ts";
import type {
  ExemptionReason,
  FindingExemption,
} from "#scripts/unread-fields/policy.ts";

type ProblemKind =
  | "duplicate finding"
  | "duplicate baseline"
  | "duplicate exemption"
  | "policy overlap"
  | "stale baseline"
  | "stale exemption"
  | "new unread field";

type PlainProblemKind = Exclude<
  ProblemKind,
  "stale exemption" | "new unread field"
>;

interface PlainProblem {
  identity: FindingIdentity;
  kind: PlainProblemKind;
}

interface StaleExemptionProblem {
  identity: FindingIdentity;
  kind: "stale exemption";
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
  | StaleExemptionProblem
  | NewUnreadFieldProblem;

const KIND_ORDER: Record<ProblemKind, number> = {
  "duplicate baseline": 1,
  "duplicate exemption": 2,
  "duplicate finding": 0,
  "new unread field": 6,
  "policy overlap": 3,
  "stale baseline": 4,
  "stale exemption": 5,
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

/** Compare the current report with accepted debt and reviewed false positives. */
export const reconcileUnreadFields =
  (
    baseline: readonly FindingIdentity[],
    exemptions: readonly FindingExemption[],
  ): ((findings: readonly Finding[]) => UnreadFieldProblem[]) =>
  (findings) => {
    const unread = findings.filter(({ verdict }) => verdict !== "read");
    const currentKeys = new Set(unread.map(findingIdentityKey));
    const baselineKeys = new Set(baseline.map(findingIdentityKey));
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
        .filter((identity) => exemptionKeys.has(findingIdentityKey(identity)))
        .map((identity) => problem("policy overlap", identity)),
      ...uniqueIdentities(baseline)
        .filter((identity) => !currentKeys.has(findingIdentityKey(identity)))
        .map((identity) => problem("stale baseline", identity)),
      ...uniqueBy(({ identity }: FindingExemption) =>
        findingIdentityKey(identity),
      )([...exemptions])
        .filter(
          ({ identity }) => !currentKeys.has(findingIdentityKey(identity)),
        )
        .map(({ identity, reason }) => ({
          identity,
          kind: "stale exemption" as const,
          reason,
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
        compareFindingIdentities(left.identity, right.identity),
    );
  };

/** One policy problem with enough identity and evidence to repair it. */
export const formatUnreadFieldProblem = (
  problem: UnreadFieldProblem,
): string => {
  const identity = findingIdentityText(problem.identity);
  if (problem.kind === "new unread field") {
    return `${problem.kind} [${problem.verdict}]: ${identity} -- declared in ${problem.file}`;
  }
  if (problem.kind === "stale exemption") {
    return `${problem.kind}: ${identity} -- ${problem.reason.kind}: ${problem.reason.evidence}`;
  }
  return `${problem.kind}: ${identity}`;
};
