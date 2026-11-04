import type { ModelDataSource } from "#scripts/verify-models/data.ts";

/** The proof phases, in the order the runner queues them. */
export const PROOF_PHASES = ["initial", "step"] as const;

export type CheckPhase = (typeof PROOF_PHASES)[number];

export type ModelControl = {
  readonly name: string;
  readonly phase: CheckPhase;
  readonly data: ModelDataSource;
};

type ModuleContext = {
  readonly module: string;
  readonly context: readonly string[];
};

export type VerificationModule = ModuleContext &
  (
    | { readonly kind: "helper" }
    | {
        readonly kind: "model";
        readonly data: ModelDataSource;
        readonly controls: readonly [ModelControl, ...ModelControl[]];
      }
  );

/** Load a producer only when the checker requests its data. */
export const dataFrom =
  <Module>(load: () => Promise<Module>) =>
  (select: (module: Module) => ModelDataSource): ModelDataSource =>
  async () =>
    select(await load())();

/** Review context is source code under the declared repository roots. */
export const isReviewSourcePath = (path: string): boolean =>
  /^(?:src|scripts|verification)\/.+\.(?:[cm]?[jt]sx?|tla)$/.test(path) &&
  !path.includes("\\") &&
  path.split("/").every((part) => part !== "" && !part.startsWith("."));
