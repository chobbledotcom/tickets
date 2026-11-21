/** Check every declared model with the pinned Apalache package from devenv. */
import { join } from "node:path";
import { checkVerification } from "#scripts/check-tla/run.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import {
  CHECKER,
  checkArgs,
  modelNames,
  modulesFor,
  plannedChecks,
  prepareArgs,
  prepareModel,
} from "#scripts/verify-models/jobs.ts";
import { forgetOldPasses, passStore } from "#scripts/verify-models/passes.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import {
  COMMAND_TIMEOUT_MS,
  outputOf,
  runChecks,
  runPool,
  secondsSince,
} from "#scripts/verify-models/run.ts";
import { workerCount } from "#scripts/verify-models/workers.ts";

const sources = join(projectRoot, "verification");

/** Each model gets a process of its own, so the producers of two models can
 *  hold their databases at the same time. */
const prepareInProcess =
  (work: string) =>
  async (module: string): Promise<void> => {
    const started = performance.now();
    const result = await outputOf(
      Deno.execPath(),
      prepareArgs(module, work),
      projectRoot,
      COMMAND_TIMEOUT_MS.prepare,
    );
    if (!result.success) {
      throw new Error(`The ${module} producer failed.\n${result.output}`);
    }
    console.log(`Prepared ${module} (${secondsSince(started)} seconds).`);
  };

const checkAll = async (only: string | undefined): Promise<void> => {
  if ((await checkVerification()) !== 0) {
    throw new Error(
      "The TLA source declarations failed their standards check.",
    );
  }
  const work = await makeScratchDir("machine-proofs-");
  const checks = plannedChecks(modulesFor(VERIFICATION_MODULES, only), work);
  const cores = navigator.hardwareConcurrency;
  const workers = workerCount(cores, Deno.systemMemoryInfo().available);
  console.log(`Run ${workers} workers on ${cores} cores.`);
  await runPool(
    [...new Set(checks.map((check) => check.module))],
    workers,
    prepareInProcess(work),
  );
  const version = await outputOf(
    CHECKER,
    ["version"],
    work,
    COMMAND_TIMEOUT_MS.version,
  );
  if (!version.success) {
    throw new Error(`The checker gave no version.\n${version.output}`);
  }
  const passDirectory = join(projectRoot, ".verify-models-passes");
  await runChecks(
    checks,
    (check) =>
      outputOf(
        CHECKER,
        checkArgs(check),
        check.directory,
        COMMAND_TIMEOUT_MS.check,
      ),
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
  await checkAll(undefined);
} else if (mode === "--list") {
  console.log(JSON.stringify(modelNames(VERIFICATION_MODULES)));
} else if (mode === "--model" && module !== undefined) {
  await checkAll(module);
} else if (mode === "--prepare" && module !== undefined && work !== undefined) {
  await prepareModel(VERIFICATION_MODULES, module, sources, work);
} else {
  throw new Error(
    "Usage: verify-models.ts [--list | --model <module> | --prepare <module> <directory>]",
  );
}
