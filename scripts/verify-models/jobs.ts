import { join } from "node:path";
import { filter, map } from "#fp";
import {
  type CheckPhase,
  dataFileName,
  type ModelLanguage,
  modelFileName,
  type VerificationModule,
} from "#scripts/verify-models/spec.ts";

type CheckInput = {
  readonly directory: string;
  readonly module: string;
  readonly language: ModelLanguage;
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
  readonly language: ModelLanguage;
  readonly module: string;
};

const writeVariant = async (
  sources: readonly ModuleSource[],
  directory: string,
  module: string,
  language: ModelLanguage,
  data: string,
): Promise<void> => {
  await Deno.mkdir(directory, { recursive: true });
  for (const source of sources) {
    await Deno.writeTextFile(
      join(directory, modelFileName(source.module, source.language)),
      source.content,
    );
  }
  await Deno.writeTextFile(
    join(directory, dataFileName(module, language)),
    data,
  );
};

/** Keep database-backed producers serial and freeze each data variant before checks start. */
export const prepareChecks = async (
  modules: readonly VerificationModule[],
  sourceDirectory: string,
  work: string,
): Promise<ModelCheck[]> => {
  const sources = await Promise.all(
    map(
      async ({
        kind,
        language,
        module,
      }: VerificationModule): Promise<ModuleSource> => ({
        content: await Deno.readTextFile(
          join(sourceDirectory, modelFileName(module, language)),
        ),
        kind,
        language,
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
      model.language,
      await model.data(),
    );
    for (const phase of ["initial", "step"] as const) {
      checks.push({
        directory,
        kind: "proof",
        language: model.language,
        module: model.module,
        phase,
      });
    }
    for (const [index, control] of model.controls.entries()) {
      const directory = join(work, model.module, `control-${index + 1}`);
      await writeVariant(
        modelSources,
        directory,
        model.module,
        model.language,
        await control.data(),
      );
      checks.push({
        directory,
        kind: "control",
        language: model.language,
        module: model.module,
        name: control.name,
        phase: control.phase,
      });
    }
  }
  return checks;
};
