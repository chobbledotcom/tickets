/** Check every declared model with its own pinned tool: Apalache for TLA+ and
 *  the Quint simulator for Quint. */
import { join } from "node:path";
import { checkVerification } from "#scripts/check-tla/run.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import {
  CHECK_PHASES,
  type CheckerResult,
  QUINT_CLI,
  QUINT_SAMPLES,
  QUINT_SEED,
  requireCounterexample,
} from "#scripts/verify-models/check.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import {
  type CheckPhase,
  dataFileName,
  type ModelLanguage,
  modelFileName,
} from "#scripts/verify-models/spec.ts";

if ((await checkVerification()) !== 0)
  throw new Error(
    "The model source declarations failed their standards check.",
  );
const work = await makeScratchDir("machine-proofs-");
const decoder = new TextDecoder();

const runCommand = async (
  command: string,
  args: string[],
): Promise<CheckerResult> => {
  const result = await new Deno.Command(command, {
    args,
    cwd: work,
    stderr: "piped",
    stdout: "piped",
  }).output();
  return {
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    success: result.success,
  };
};

/** Each language checks the same two obligations with its own tool. */
const checkModel = (
  module: string,
  language: ModelLanguage,
  phase: CheckPhase,
): Promise<CheckerResult> => {
  const check = CHECK_PHASES[phase];
  const model = modelFileName(module, language);
  if (language === "tla")
    return runCommand("apalache-mc", [
      "check",
      `--init=${check.init.tla}`,
      "--next=Next",
      "--inv=Safety",
      `--length=${check.length}`,
      model,
    ]);
  return runCommand(Deno.execPath(), [
    "run",
    "-A",
    QUINT_CLI,
    "run",
    "--backend=typescript",
    `--init=${check.init.quint}`,
    "--step=step",
    "--invariant=safety",
    `--seed=${QUINT_SEED}`,
    `--max-samples=${QUINT_SAMPLES}`,
    `--max-steps=${check.length}`,
    model,
  ]);
};

const quintTypecheck = (module: string): Promise<CheckerResult> =>
  runCommand(Deno.execPath(), [
    "run",
    "-A",
    QUINT_CLI,
    "typecheck",
    modelFileName(module, "quint"),
  ]);

for (const entry of VERIFICATION_MODULES) {
  await Deno.copyFile(
    join(
      projectRoot,
      "verification",
      modelFileName(entry.module, entry.language),
    ),
    join(work, modelFileName(entry.module, entry.language)),
  );
}

for (const model of VERIFICATION_MODULES) {
  if (model.kind !== "model") continue;
  const dataPath = join(work, dataFileName(model.module, model.language));
  await Deno.writeTextFile(dataPath, await model.data());
  if (model.language === "quint") {
    console.log(`Check ${model.module}: Quint types and effects.`);
    const types = await quintTypecheck(model.module);
    if (!types.success) {
      throw new Error(
        `${model.module} failed the Quint type check. Read ${work}.\n${types.output}`,
      );
    }
  }
  for (const phase of ["initial", "step"] as const) {
    console.log(`Check ${model.module}: ${CHECK_PHASES[phase].name}.`);
    const result = await checkModel(model.module, model.language, phase);
    if (!result.success) {
      throw new Error(
        `${model.module} proof failed. Read ${work}.\n${result.output}`,
      );
    }
  }
  for (const control of model.controls) {
    console.log(`Check ${model.module}: ${control.name} counterexample.`);
    await Deno.writeTextFile(dataPath, await control.data());
    requireCounterexample(
      await checkModel(model.module, model.language, control.phase),
      control.name,
      work,
      model.language,
    );
  }
}
await Deno.remove(work, { recursive: true });
console.log(
  "All model initial states and steps passed. Every negative control produced a counterexample.",
);
