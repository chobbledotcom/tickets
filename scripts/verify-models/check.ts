import type { CheckPhase, ModelLanguage } from "#scripts/verify-models/spec.ts";

/** Each language names its own starting action for the same obligation. */
export const CHECK_PHASES: Record<
  CheckPhase,
  { init: Record<ModelLanguage, string>; length: number; name: string }
> = {
  initial: {
    init: { quint: "init", tla: "Init" },
    length: 0,
    name: "initial state",
  },
  step: {
    init: { quint: "safetyInit", tla: "Safety" },
    length: 1,
    name: "unrestricted safety step",
  },
};

export type CheckerResult = {
  readonly success: boolean;
  readonly output: string;
};

/** Each checker prints its own evidence of a violation and its trace. */
const COUNTEREXAMPLE: Record<ModelLanguage, readonly RegExp[]> = {
  quint: [/\[violation\]/, /An example execution:/],
  tla: [/violated/, /Check the trace in:/],
};

/** A failed command is evidence only when it names a violation and its trace. */
export const requireCounterexample = (
  result: CheckerResult,
  label: string,
  work: string,
  language: ModelLanguage,
): void => {
  if (result.success) {
    throw new Error(
      `The checker accepted ${label}. Read the artifacts in ${work}.`,
    );
  }
  if (
    !COUNTEREXAMPLE[language].every((pattern) => pattern.test(result.output))
  ) {
    throw new Error(
      `The checker produced no invariant violation and trace for ${label}. Read ${work}.\n${result.output}`,
    );
  }
};
