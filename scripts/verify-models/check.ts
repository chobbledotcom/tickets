import type { CheckPhase } from "#scripts/verify-models/spec.ts";

export const CHECK_PHASES: Record<
  CheckPhase,
  { init: string; length: number; name: string }
> = {
  initial: { init: "Init", length: 0, name: "initial state" },
  step: { init: "Safety", length: 1, name: "unrestricted safety step" },
};

export type CheckerResult = {
  readonly success: boolean;
  readonly output: string;
};

/** A failed command is evidence only when it names a violation and its trace. */
export const requireCounterexample = (
  result: CheckerResult,
  label: string,
  work: string,
): void => {
  if (result.success) {
    throw new Error(
      `The checker accepted ${label}. Read the artifacts in ${work}.`,
    );
  }
  if (
    !/violated/.test(result.output) ||
    !/Check the trace in:/.test(result.output)
  ) {
    throw new Error(
      `The checker produced no invariant violation and trace for ${label}. Read ${work}.\n${result.output}`,
    );
  }
};
