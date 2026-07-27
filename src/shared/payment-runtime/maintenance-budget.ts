import type { SubrequestCounts } from "#shared/subrequest-budget.ts";

/** One due lookup plus one worst-case payment runtime invocation. */
export const PAYMENT_RECONCILIATION_TASK_BUDGET = {
  database: 22,
  external: 11,
} as const;

export const PAYMENT_RECONCILIATION_ITEM_BUDGET: SubrequestCounts = {
  database: PAYMENT_RECONCILIATION_TASK_BUDGET.database - 1,
  external: PAYMENT_RECONCILIATION_TASK_BUDGET.external,
  total:
    PAYMENT_RECONCILIATION_TASK_BUDGET.database +
    PAYMENT_RECONCILIATION_TASK_BUDGET.external -
    1,
};

/** One due lookup plus one reclaimed owner decision. */
export const PAYMENT_DECISION_TASK_BUDGET = {
  database: 22,
  external: 10,
} as const;

export const PAYMENT_DECISION_ITEM_BUDGET: SubrequestCounts = {
  database: PAYMENT_DECISION_TASK_BUDGET.database - 1,
  external: PAYMENT_DECISION_TASK_BUDGET.external,
  total:
    PAYMENT_DECISION_TASK_BUDGET.database +
    PAYMENT_DECISION_TASK_BUDGET.external -
    1,
};

/** Two due lookups plus the larger of one decision or reconciliation item. */
export const PAYMENT_MAINTENANCE_TASK_BUDGET = {
  database: 23,
  external: 11,
} as const;

/** Four alert claim/send/mark attempts, each using two writes and one fetch. */
export const PAYMENT_CASE_ALERT_TASK_BUDGET = {
  database: 8,
  external: 4,
} as const;

export const PAYMENT_CASE_ALERT_ITEM_BUDGET: SubrequestCounts = {
  database: 2,
  external: 1,
  total: 3,
};
