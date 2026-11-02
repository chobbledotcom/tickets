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
} from "#scripts/verify-models/check.ts";
import { type ModelCheck, prepareChecks } from "#scripts/verify-models/jobs.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import { runChecks } from "#scripts/verify-models/run.ts";
import { modelFileName } from "#scripts/verify-models/spec.ts";

if ((await checkVerification()) !== 0)
  throw new Error(
    "The model source declarations failed their standards check.",
  );
const work = await makeScratchDir("machine-proofs-");
const checks = await prepareChecks(
  VERIFICATION_MODULES,
  join(projectRoot, "verification"),
  work,
);
const decoder = new TextDecoder();

const runCommand = async (
  command: string,
  args: string[],
  directory: string,
): Promise<CheckerResult> => {
  const result = await new Deno.Command(command, {
    args,
    cwd: directory,
    stderr: "piped",
    stdout: "piped",
  }).output();
  return {
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    success: result.success,
  };
};

const runCheck = async (check: ModelCheck): Promise<CheckerResult> => {
  const phase = CHECK_PHASES[check.phase];
  if (check.language === "quint") {
    return runCommand(
      Deno.execPath(),
      [
        "run",
        "-A",
        QUINT_CLI,
        "run",
        "--backend=typescript",
        `--init=${phase.init.quint}`,
        "--step=step",
        "--invariant=safety",
        `--seed=${QUINT_SEED}`,
        `--max-samples=${QUINT_SAMPLES}`,
        `--max-steps=${phase.length}`,
        modelFileName(check.module, "quint"),
      ],
      check.directory,
    );
  }
  return runCommand(
    "apalache-mc",
    [
      "check",
      `--init=${phase.init.tla}`,
      "--next=Next",
      "--inv=Safety",
      `--length=${phase.length}`,
      modelFileName(check.module, "tla"),
    ],
    check.directory,
  );
};

/** The Quint checker decides the grammar and the effects, so one type check
 *  guards every phase and control of a Quint model. */
const typecheckQuintModels = async (): Promise<void> => {
  const models = checks.filter(
    (check) =>
      check.kind === "proof" &&
      check.phase === "initial" &&
      check.language === "quint",
  );
  for (const check of models) {
    console.log(`Check ${check.module}: Quint types and effects.`);
    const result = await runCommand(
      Deno.execPath(),
      [
        "run",
        "-A",
        QUINT_CLI,
        "typecheck",
        modelFileName(check.module, "quint"),
      ],
      check.directory,
    );
    if (!result.success) {
      throw new Error(
        `${check.module} failed the Quint type check. Read ${check.directory}.\n${result.output}`,
      );
    }
  }
};

await typecheckQuintModels();
await runChecks(checks, runCheck);
await Deno.remove(work, { recursive: true });
console.log(
  "All model initial states and steps passed. Every negative control produced a counterexample.",
);
