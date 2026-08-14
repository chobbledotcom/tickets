/**
 * Run every teardown action and report the whole truth.
 *
 * A cleanup step must never prevent the remaining steps from running, and a
 * cleanup failure must never hide a more important scenario error — but it must
 * fail an otherwise-green scenario. These helpers encode that contract.
 */

export interface NamedCleanup {
  /** What this step releases, named for the error message. */
  name: string;
  run: () => Promise<void>;
}

export interface CleanupOutcome {
  /** The errors of every step that failed, in the order they ran. */
  errors: Error[];
}

/**
 * Attempt every cleanup in order, collecting failures instead of stopping at
 * the first. Each failure is wrapped with its step name so the report says
 * which resource leaked.
 */
export const attemptEveryCleanup = async (
  steps: readonly NamedCleanup[],
): Promise<CleanupOutcome> => {
  const errors: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      errors.push(
        error instanceof Error
          ? new Error(`cleanup of ${step.name} failed: ${error.message}`, {
              cause: error,
            })
          : new Error(`cleanup of ${step.name} failed: ${String(error)}`),
      );
    }
  }
  return { errors };
};

/**
 * Turn cleanup failures into the error a scenario should fail with: none when
 * every step succeeded; the aggregate when the scenario itself passed (a leak
 * fails a green journey); nothing thrown when the scenario already failed (the
 * original error must stay the one people see — the cleanup failures were
 * already reported alongside it by the caller).
 */
export const cleanupErrorForScenario = (
  outcome: CleanupOutcome,
  scenarioAlreadyFailed: boolean,
): Error | null => {
  if (outcome.errors.length === 0) return null;
  if (scenarioAlreadyFailed) return null;
  return new AggregateError(outcome.errors, "scenario cleanup failed");
};
