import type { MaintenanceTaskDeclaration } from "#shared/maintenance/definition.ts";

type MaintenanceTaskOverrides = Omit<
  Partial<MaintenanceTaskDeclaration>,
  "check"
> & {
  check?: Partial<MaintenanceTaskDeclaration["check"]>;
};

export const maintenanceDeclaration = (
  name: string,
  run: MaintenanceTaskDeclaration["run"],
  overrides: MaintenanceTaskOverrides = {},
): MaintenanceTaskDeclaration => {
  const { check, ...taskOverrides } = overrides;
  return {
    check: {
      enabled: () => true,
      maxDatabaseCalls: 0,
      maxExternalCalls: 0,
      settingsKeys: [],
      ...check,
    },
    deadlineMs: 10_000,
    failureRetryIntervalMs: 60_000,
    intervalMs: 60_000,
    maxDatabaseCalls: 0,
    maxExternalCalls: 0,
    name,
    run,
    wakePolicy: "organic_safe",
    ...taskOverrides,
  };
};
