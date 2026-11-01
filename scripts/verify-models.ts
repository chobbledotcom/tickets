/** Check every declared model with the pinned Apalache package from devenv. */
import { join } from "node:path";
import { checkVerification } from "#scripts/check-tla/run.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import {
  CHECK_PHASES,
  type CheckerResult,
  requireCounterexample,
} from "#scripts/verify-models/check.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import type { CheckPhase } from "#scripts/verify-models/spec.ts";

if ((await checkVerification()) !== 0)
  throw new Error("The TLA source declarations failed their standards check.");
const work = await makeScratchDir("machine-proofs-");
const decoder = new TextDecoder();
for (const entry of VERIFICATION_MODULES) {
  await Deno.copyFile(
    join(projectRoot, `verification/${entry.module}.tla`),
    join(work, `${entry.module}.tla`),
  );
}

const runCheck = async (
  module: string,
  phase: CheckPhase,
): Promise<CheckerResult> => {
  const check = CHECK_PHASES[phase];
  const result = await new Deno.Command("apalache-mc", {
    args: [
      "check",
      `--init=${check.init}`,
      "--next=Next",
      "--inv=Safety",
      `--length=${check.length}`,
      `${module}.tla`,
    ],
    cwd: work,
    stderr: "piped",
    stdout: "piped",
  }).output();
  return {
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    success: result.success,
  };
};

for (const model of VERIFICATION_MODULES) {
  if (model.kind !== "model") continue;
  const dataPath = join(work, `${model.module}Data.tla`);
  await Deno.writeTextFile(dataPath, await model.data());
  for (const phase of ["initial", "step"] as const) {
    console.log(`Check ${model.module}: ${CHECK_PHASES[phase].name}.`);
    const result = await runCheck(model.module, phase);
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
      await runCheck(model.module, control.phase),
      control.name,
      work,
    );
  }
}
await Deno.remove(work, { recursive: true });
console.log(
  "All model initial states and unrestricted steps passed. Every negative control produced a counterexample.",
);
