import { join } from "node:path";
import { filter, map } from "#fp";
import { CHECK_PHASES } from "#scripts/verify-models/check.ts";
import type { ModelDataSource } from "#scripts/verify-models/data.ts";
import type {
  CheckPhase,
  ModelControl,
  VerificationModule,
} from "#scripts/verify-models/spec.ts";
import { requireValue } from "#shared/required-value.ts";

type CheckInput = {
  readonly directory: string;
  readonly module: string;
  readonly phase: CheckPhase;
};

export type ModelCheck = CheckInput &
  (
    | { readonly kind: "proof" }
    | { readonly kind: "control"; readonly name: string }
    | { readonly kind: "scope"; readonly name: string }
  );

/** The checker command. */
export const CHECKER = "apalache-mc";

/** The checker arguments that decide a verdict. */
export const checkArgs = (check: ModelCheck): string[] => {
  const phase = CHECK_PHASES[check.phase];
  return [
    "check",
    `--init=${phase.init}`,
    "--next=Next",
    "--inv=Safety",
    `--length=${phase.length}`,
    `${check.module}.tla`,
  ];
};

type ModuleSource = {
  readonly content: string;
  readonly module: string;
};

const writeVariant = async (
  sources: readonly ModuleSource[],
  directory: string,
  module: string,
  data: string,
): Promise<void> => {
  await Deno.mkdir(directory, { recursive: true });
  for (const source of sources) {
    await Deno.writeTextFile(
      join(directory, `${source.module}.tla`),
      source.content,
    );
  }
  await Deno.writeTextFile(join(directory, `${module}Data.tla`), data);
};

type ModelModule = Extract<VerificationModule, { kind: "model" }>;

type Variant = {
  readonly check: ModelCheck;
  readonly data: ModelDataSource;
};

/** The checks of one control: its scope, when it has one, then the control. */
const controlVariants = (
  module: string,
  work: string,
  control: ModelControl,
  index: number,
): Variant[] => {
  const check = {
    directory: join(work, module, `control-${index + 1}`),
    module,
    name: control.name,
    phase: control.phase,
  };
  const scope: Variant[] =
    control.scope === undefined
      ? []
      : [
          {
            check: {
              ...check,
              directory: `${check.directory}-scope`,
              kind: "scope",
            },
            data: control.scope,
          },
        ];
  return [
    ...scope,
    { check: { ...check, kind: "control" }, data: control.data },
  ];
};

/** The two proofs read one clean data module. Each control reads its own. */
const modelVariants = (model: ModelModule, work: string): Variant[] => {
  const { module } = model;
  let clean: Promise<string> | undefined;
  const cleanData: ModelDataSource = () => {
    clean ??= model.data();
    return clean;
  };
  return [
    ...map(
      (phase: CheckPhase): Variant => ({
        check: {
          directory: join(work, module, phase),
          kind: "proof",
          module,
          phase,
        },
        data: cleanData,
      }),
    )(["initial", "step"]),
    ...model.controls.flatMap((control, index) =>
      controlVariants(module, work, control, index),
    ),
  ];
};

const models = (modules: readonly VerificationModule[]): ModelModule[] =>
  modules.filter(
    (module: VerificationModule): module is ModelModule =>
      module.kind === "model",
  );
/** Every check that the models declare, each with a work directory of its own. */
export const plannedChecks = (
  modules: readonly VerificationModule[],
  work: string,
): ModelCheck[] =>
  models(modules).flatMap((model) =>
    modelVariants(model, work).map((variant) => variant.check),
  );

/** Keep the database-backed producers of one model serial, and freeze each
 *  data variant before a check starts. */
export const prepareModel = async (
  modules: readonly VerificationModule[],
  module: string,
  sourceDirectory: string,
  work: string,
): Promise<void> => {
  const model = requireValue(
    models(modules).find((entry) => entry.module === module),
    `No registered model has the name ${module}.`,
  );
  const sources = await Promise.all(
    map(
      async (source: VerificationModule): Promise<ModuleSource> => ({
        content: await Deno.readTextFile(
          join(sourceDirectory, `${source.module}.tla`),
        ),
        module: source.module,
      }),
    )(
      filter(
        (source: VerificationModule) =>
          source.kind === "helper" || source.module === module,
      )([...modules]),
    ),
  );
  for (const { check, data } of modelVariants(model, work)) {
    await writeVariant(sources, check.directory, module, await data());
  }
};
