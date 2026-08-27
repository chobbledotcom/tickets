import { namedError } from "#shared/named-error.ts";
import { createScope } from "#shared/request-scoped.ts";

/** Bunny Edge Scripting stops an incoming request after this many subrequests. */
export const BUNNY_SUBREQUEST_LIMIT = 50;

export type SubrequestKind = "database" | "external";

export type SubrequestCounts = {
  database: number;
  external: number;
  total: number;
};

type Counts = { database: number; external: number };
type BudgetState = {
  counts: Counts;
  limits: Counts & { total: number };
};

/**
 * This request has no subrequests left for the work it was about to start.
 *
 * Both refusals below raise it: the call blocked at the cap, and the block of
 * work refused up front because its reserved tail no longer fits. A caller that
 * can stop and continue on a later request — the migration runner — tells the
 * two apart from a real defect by this type, never by the message text.
 */
export class SubrequestBudgetError extends namedError(
  "SubrequestBudgetError",
) {}

const budgetScope = createScope<BudgetState>();

const freshBudget = (): BudgetState => ({
  counts: { database: 0, external: 0 },
  limits: {
    database: BUNNY_SUBREQUEST_LIMIT,
    external: BUNNY_SUBREQUEST_LIMIT,
    total: BUNNY_SUBREQUEST_LIMIT,
  },
});

const usageOf = ({ database, external }: Counts): SubrequestCounts => ({
  database,
  external,
  total: database + external,
});

export const getSubrequestUsage = (): SubrequestCounts =>
  usageOf(budgetScope.current()?.counts ?? { database: 0, external: 0 });

export const getSubrequestRemaining = (): SubrequestCounts => {
  const state = budgetScope.current();
  if (!state) {
    return {
      database: BUNNY_SUBREQUEST_LIMIT,
      external: BUNNY_SUBREQUEST_LIMIT,
      total: BUNNY_SUBREQUEST_LIMIT,
    };
  }
  const usage = usageOf(state.counts);
  return {
    database: Math.max(0, state.limits.database - usage.database),
    external: Math.max(0, state.limits.external - usage.external),
    total: Math.max(0, state.limits.total - usage.total),
  };
};

/** Leave a fixed tail for work that must still run after `fn` finishes. */
export const withSubrequestReserve = <T>(
  reserve: SubrequestCounts,
  fn: () => T,
): T => {
  const remaining = getSubrequestRemaining();
  if (
    reserve.database > remaining.database ||
    reserve.external > remaining.external ||
    reserve.total > remaining.total
  ) {
    throw new SubrequestBudgetError(
      `Subrequest reserve unavailable: need ${reserve.database} database + ` +
        `${reserve.external} external calls (${reserve.total} total), but ` +
        `${remaining.database} database + ${remaining.external} external ` +
        `calls (${remaining.total} total) remain`,
    );
  }
  return withSubrequestAllowance(
    {
      database: remaining.database - reserve.database,
      external: remaining.external - reserve.external,
      total: remaining.total - reserve.total,
    },
    fn,
  );
};

export const runWithSubrequestBudget = <T>(fn: () => T): T =>
  budgetScope.run(freshBudget(), fn);

export const withSubrequestAllowance = <T>(
  allowance: SubrequestCounts,
  fn: () => T,
): T => {
  const parent = budgetScope.current();
  if (!parent) {
    return runWithSubrequestBudget(() =>
      withSubrequestAllowance(allowance, fn),
    );
  }
  const usage = usageOf(parent.counts);
  return budgetScope.run(
    {
      counts: parent.counts,
      limits: {
        database: Math.min(
          parent.limits.database,
          usage.database + allowance.database,
        ),
        external: Math.min(
          parent.limits.external,
          usage.external + allowance.external,
        ),
        total: Math.min(parent.limits.total, usage.total + allowance.total),
      },
    },
    fn,
  );
};

/**
 * Count one subrequest, throwing when it takes the budget over its limit.
 *
 * `enforce: false` still counts the call — so the running total stays accurate
 * for every later call — but never throws. It is for mandatory cleanup (a
 * transaction rollback) that must run even once the budget is spent: blocking it
 * would leave the transaction open, and hiding it entirely would under-count and
 * let a later call slip past the guard into a real over-limit rejection.
 */
export const countSubrequest = (
  kind: SubrequestKind,
  operation: string,
  enforce = true,
): void => {
  const state = budgetScope.current();
  if (!state) return;
  const nextCounts = { ...state.counts, [kind]: state.counts[kind] + 1 };
  const usage = usageOf(nextCounts);
  if (
    enforce &&
    (nextCounts[kind] > state.limits[kind] || usage.total > state.limits.total)
  ) {
    throw new SubrequestBudgetError(
      `Subrequest allowance exceeded: ${usage.database} database + ` +
        `${usage.external} external calls. Blocked ${kind} operation: ${operation}`,
    );
  }
  state.counts[kind] += 1;
};

export const countExternalSubrequest = (operation: string): void =>
  countSubrequest("external", operation);
