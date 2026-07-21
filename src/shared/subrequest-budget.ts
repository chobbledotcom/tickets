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

export const runWithSubrequestBudget = <T>(fn: () => T): T =>
  budgetScope.run(freshBudget(), fn);

export const withSubrequestAllowance = <T>(
  allowance: SubrequestCounts,
  fn: () => T,
): T => {
  const parent = budgetScope.current();
  if (!parent)
    return runWithSubrequestBudget(() =>
      withSubrequestAllowance(allowance, fn),
    );
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

export const countSubrequest = (
  kind: SubrequestKind,
  operation: string,
): void => {
  const state = budgetScope.current();
  if (!state) return;
  state.counts[kind] += 1;
  const usage = usageOf(state.counts);
  if (
    state.counts[kind] > state.limits[kind] ||
    usage.total > state.limits.total
  ) {
    throw new Error(
      `Subrequest allowance exceeded: ${usage.database} database + ` +
        `${usage.external} external calls. Blocked ${kind} operation: ${operation}`,
    );
  }
};

export const countExternalSubrequest = (operation: string): void =>
  countSubrequest("external", operation);

/** A refund uses several database calls plus one payment-provider request. */
export const BULK_REFUND_LIMIT = 5;
