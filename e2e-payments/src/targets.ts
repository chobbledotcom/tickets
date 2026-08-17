/**
 * The exhaustive target-to-case selection for the live payment harness.
 *
 * One `Record` says which Cucumber case ids each nightly target runs; the tag
 * expression, the catalog handshake, and the executed-count check all derive
 * from it, so a renamed or deleted case fails the run instead of silently
 * producing a green job that did no work.
 */

import type { Envelope } from "@cucumber/messages";
import type { SpecCatalog } from "#scripts/specs/types.ts";

export type LiveTarget = "free" | "stripe" | "square" | "sumup";

export const LIVE_TARGETS: readonly LiveTarget[] = [
  "free",
  "stripe",
  "square",
  "sumup",
];

/** The one Feature the live harness runs. */
export const LIVE_FEATURE_PATH =
  "e2e-payments/specs/live-payment-providers.feature";

export type LiveCaseId =
  | "live-payments.free-booking-once"
  | "live-payments.complex-free"
  | "live-payments.stripe-refund-recovers"
  | "live-payments.stripe-invalidated-checkout-refunded"
  | "live-payments.complex-stripe"
  | "live-payments.square-refund-safe"
  | "live-payments.complex-square"
  | "live-payments.sumup-refund-safe"
  | "live-payments.complex-sumup";

/** Every case each target must execute — the whole contract in one record. */
export const TARGET_CASES: Record<LiveTarget, readonly LiveCaseId[]> = {
  free: ["live-payments.free-booking-once", "live-payments.complex-free"],
  square: ["live-payments.square-refund-safe", "live-payments.complex-square"],
  stripe: [
    "live-payments.stripe-refund-recovers",
    "live-payments.stripe-invalidated-checkout-refunded",
    "live-payments.complex-stripe",
  ],
  sumup: ["live-payments.sumup-refund-safe", "live-payments.complex-sumup"],
};

/** Parse the target name the command was invoked with. */
export const parseLiveTarget = (raw: string | undefined): LiveTarget => {
  const target = (raw ?? "").toLowerCase();
  if ((LIVE_TARGETS as readonly string[]).includes(target)) {
    return target as LiveTarget;
  }
  throw new Error(
    `unknown target "${raw ?? ""}" (expected free|stripe|square|sumup)`,
  );
};

/** The `@case:… or @case:…` expression selecting one target's cases. */
export const caseExpression = (ids: readonly LiveCaseId[]): string =>
  ids.map((id) => `@case:${id}`).join(" or ");

import { specCasesWithContext } from "#scripts/specs/types.ts";

/** Every case id the catalog carries, in catalog order. */
export const catalogCaseIds = (catalog: SpecCatalog): string[] =>
  specCasesWithContext(catalog).map(({ specCase }) => specCase.id);

/**
 * Assert the catalog and the target record describe the same contract: every
 * target id exists exactly once, and every catalog case is claimed by exactly
 * one target. A case that exists but no target runs is a nightly hole, so it
 * fails here rather than never executing.
 */
export const verifyCatalogTargets = (catalog: SpecCatalog): void => {
  const ids = catalogCaseIds(catalog);
  const claimed = LIVE_TARGETS.flatMap((target) => TARGET_CASES[target]);
  const missing = claimed.filter(
    (id) => ids.filter((catalogId) => catalogId === id).length !== 1,
  );
  if (missing.length > 0) {
    throw new Error(
      `the live payment feature must carry each of these case ids exactly once: ${[
        ...new Set(missing),
      ].join(", ")}`,
    );
  }
  const unclaimed = ids.filter((id) => !claimed.includes(id as LiveCaseId));
  if (unclaimed.length > 0) {
    throw new Error(
      `no nightly target runs these live payment cases: ${unclaimed.join(
        ", ",
      )}`,
    );
  }
};

/** How many Cucumber test cases finished (any status). */
export const executedCaseCount = (messages: Envelope[]): number =>
  messages.filter((message) => message.testCaseFinished !== undefined).length;

/** Require that exactly the selected number of cases ran for this target. */
export const verifyExecutedCases = (
  messages: Envelope[],
  expected: readonly LiveCaseId[],
): void => {
  const executed = executedCaseCount(messages);
  if (executed !== expected.length) {
    throw new Error(
      `expected ${expected.length} executed case(s) (${expected.join(", ")}) ` +
        `but Cucumber finished ${executed}`,
    );
  }
};
