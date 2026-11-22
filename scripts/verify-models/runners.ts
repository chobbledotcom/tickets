import { modelNames } from "#scripts/verify-models/jobs.ts";
import type { VerificationModule } from "#scripts/verify-models/spec.ts";

/** The runner that a model gets when it is not named in `MODEL_RUNNERS`. */
export const DEFAULT_RUNNER = "ubicloud-standard-2";

/** Slow models get more cores. A runner costs per minute in proportion to its
 *  cores, so a larger runner pays only when it finishes twice as fast. */
export const MODEL_RUNNERS: Readonly<Record<string, string>> = {
  ModalFocus: "ubicloud-standard-4",
  SubscriptionLifecycle: "ubicloud-standard-8",
  SubscriptionRenewals: "ubicloud-standard-4",
};

/** One model check job: the model and the runner that runs it. */
export type ModelRun = { readonly model: string; readonly runner: string };

export const runnerFor = (model: string): string =>
  MODEL_RUNNERS[model] ?? DEFAULT_RUNNER;

/** The model check jobs, in registry order, each with its runner. */
export const modelRuns = (modules: readonly VerificationModule[]): ModelRun[] =>
  modelNames(modules).map((model) => ({ model, runner: runnerFor(model) }));
