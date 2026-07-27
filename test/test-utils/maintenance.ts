import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import type { SubrequestCounts } from "#shared/subrequest-budget.ts";

export const maintenanceContext = (
  remaining: SubrequestCounts,
  overrides: Partial<MaintenanceTaskContext> = {},
): MaintenanceTaskContext => ({
  budget: { remaining: () => remaining },
  checkpoint: null,
  completeTask: () => {},
  deadline: Date.now() + 10_000,
  requestFollowUp: () => {},
  setCheckpoint: () => {},
  ...overrides,
});
