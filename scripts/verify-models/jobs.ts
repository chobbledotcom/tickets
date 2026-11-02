import { join } from "node:path";
import { filter, map } from "#fp";
import type {
  CheckPhase,
  VerificationModule,
} from "#scripts/verify-models/spec.ts";

type CheckInput = {
  readonly directory: string;
  readonly module: string;
  readonly phase: CheckPhase;
};

export type ModelCheck = CheckInput &
  (
    | { readonly kind: "proof" }
    | { readonly kind: "control"; readonly name: string }
  );

type ModuleSource = {
  readonly content: string;
  readonly kind: VerificationModule["kind"];
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

/** Keep database-backed producers serial and freeze each data variant before checks start. */
export const prepareChecks = async (
  modules: readonly VerificationModule[],
  sourceDirectory: string,
  work: string,
): Promise<ModelCheck[]> => {
  const sources = await Promise.all(
    map(
      async ({ kind, module }: VerificationModule): Promise<ModuleSource> => ({
        content: await Deno.readTextFile(
          join(sourceDirectory, `${module}.tla`),
        ),
        kind,
        module,
      }),
    )(modules),
  );
  const checks: ModelCheck[] = [];
  for (const model of modules) {
    if (model.kind === "helper") continue;
    const modelSources = filter(
      (source: ModuleSource) =>
        source.kind === "helper" || source.module === model.module,
    )(sources);
    const directory = join(work, model.module, "clean");
    await writeVariant(
      modelSources,
      directory,
      model.module,
      await model.data(),
    );
    for (const phase of ["initial", "step"] as const) {
      checks.push({ directory, kind: "proof", module: model.module, phase });
    }
    for (const [index, control] of model.controls.entries()) {
      const directory = join(work, model.module, `control-${index + 1}`);
      await writeVariant(
        modelSources,
        directory,
        model.module,
        await control.data(),
      );
      checks.push({
        directory,
        kind: "control",
        module: model.module,
        name: control.name,
        phase: control.phase,
      });
    }
  }
  return checks;
};
