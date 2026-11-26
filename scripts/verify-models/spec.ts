import type { ModelDataSource } from "#scripts/verify-models/data.ts";

export type CheckPhase = "initial" | "step";

export type ModelControl = {
  readonly name: string;
  readonly phase: CheckPhase;
  readonly data: ModelDataSource;
  /** The facts that a reduced control keeps, before its fault. The checker
   *  must accept them, so the fault alone causes the counterexample. A control
   *  on the complete clean facts has no scope. */
  readonly scope?: ModelDataSource;
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

/** A control names the producer export that supplies its facts. */
type ControlDefinition<Name extends string> = readonly [
  name: string,
  phase: CheckPhase,
  data: Name,
];

/** Declare a model whose facts come from the exports of one lazy producer. The
 * declaration names each export. Nothing loads until the checker asks. */
export const modelFrom = <
  const Name extends string,
  Producer extends Record<Name, ModelDataSource>,
>(
  load: () => Promise<Producer>,
  declaration: {
    readonly context: readonly string[];
    readonly controls: readonly [
      ControlDefinition<Name>,
      ...ControlDefinition<Name>[],
    ];
    readonly data: Name;
    readonly module: string;
  },
): Extract<VerificationModule, { readonly kind: "model" }> => {
  const lazy = dataFrom(load);
  return {
    context: declaration.context,
    controls: declaration.controls.map(([name, phase, data]) => ({
      data: lazy((producer) => producer[data]),
      name,
      phase,
    })) as [ModelControl, ...ModelControl[]],
    data: lazy((producer) => producer[declaration.data]),
    kind: "model",
    module: declaration.module,
  };
};

/** Review context is source code under the declared repository roots. */
export const isReviewSourcePath = (path: string): boolean =>
  /^(?:src|scripts|verification)\/.+\.(?:[cm]?tsx?|tla)$/.test(path) &&
  !path.includes("\\") &&
  path.split("/").every((part) => part !== "" && !part.startsWith("."));
