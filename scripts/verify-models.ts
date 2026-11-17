/** Check every declared model with the pinned Apalache package from devenv. */
import { join } from "node:path";
import { checkVerification } from "#scripts/check-tla/run.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import type { CheckerResult } from "#scripts/verify-models/check.ts";
import {
  CHECKER,
  checkArgs,
  plannedChecks,
  prepareModel,
} from "#scripts/verify-models/jobs.ts";
import { forgetOldPasses, passStore } from "#scripts/verify-models/passes.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import {
  runChecks,
  runPool,
  secondsSince,
} from "#scripts/verify-models/run.ts";
import { workerCount } from "#scripts/verify-models/workers.ts";

const sources = join(projectRoot, "verification");
const decoder = new TextDecoder();

const outputOf = async (
  command: string,
  args: string[],
  cwd: string,
): Promise<CheckerResult> => {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    stderr: "piped",
    stdout: "piped",
  }).output();
  return {
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    success: result.success,
  };
};

/** Each model gets a process of its own, so the producers of two models can
 *  hold their databases at the same time. */
const prepareInProcess =
  (work: string) =>
  async (module: string): Promise<void> => {
    const started = performance.now();
    const result = await outputOf(
      Deno.execPath(),
      ["run", "-A", "scripts/verify-models.ts", "--prepare", module, work],
      projectRoot,
    );
    if (!result.success) {
      throw new Error(`The ${module} producer failed.\n${result.output}`);
    }
    console.log(`Prepared ${module} (${secondsSince(started)} seconds).`);
  };

const checkAll = async (): Promise<void> => {
  if ((await checkVerification()) !== 0) {
    throw new Error(
      "The TLA source declarations failed their standards check.",
    );
  }
  const work = await makeScratchDir("machine-proofs-");
  const checks = plannedChecks(VERIFICATION_MODULES, work);
  const cores = navigator.hardwareConcurrency;
  const workers = workerCount(cores, Deno.systemMemoryInfo().available);
  console.log(`Run ${workers} workers on ${cores} cores.`);
  await runPool(
    [...new Set(checks.map((check) => check.module))],
    workers,
    prepareInProcess(work),
  );
  const version = await outputOf(CHECKER, ["version"], work);
  if (!version.success) {
    throw new Error(`The checker gave no version.\n${version.output}`);
  }
  const passDirectory = join(projectRoot, ".verify-models-passes");
  await runChecks(
    checks,
    (check) => outputOf(CHECKER, checkArgs(check), check.directory),
    workers,
    await passStore(passDirectory, `${CHECKER} ${version.output.trim()}`),
  );
  await forgetOldPasses(passDirectory, Date.now());
  await Deno.remove(work, { recursive: true });
  console.log(
    "All model initial states and unrestricted steps passed. Every negative control produced a counterexample.",
  );
};

const [mode, module, work] = Deno.args;
if (mode === undefined) {
  await checkAll();
} else if (mode === "--prepare" && module !== undefined && work !== undefined) {
  await prepareModel(VERIFICATION_MODULES, module, sources, work);
} else {
  throw new Error("Usage: verify-models.ts [--prepare <module> <directory>]");
}
