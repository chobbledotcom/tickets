/** Check every declared model with the pinned Apalache package from devenv. */
import { join } from "node:path";
import { checkVerification } from "#scripts/check-tla/run.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { makeScratchDir } from "#scripts/scratch.ts";
import {
  CHECK_PHASES,
  type CheckerResult,
} from "#scripts/verify-models/check.ts";
import { type ModelCheck, prepareChecks } from "#scripts/verify-models/jobs.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import { runChecks } from "#scripts/verify-models/run.ts";

if ((await checkVerification()) !== 0)
  throw new Error("The TLA source declarations failed their standards check.");
const work = await makeScratchDir("machine-proofs-");
const checks = await prepareChecks(
  VERIFICATION_MODULES,
  join(projectRoot, "verification"),
  work,
);
const decoder = new TextDecoder();

const runCheck = async ({
  directory,
  module,
  phase,
}: ModelCheck): Promise<CheckerResult> => {
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
    cwd: directory,
    stderr: "piped",
    stdout: "piped",
  }).output();
  return {
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    success: result.success,
  };
};

await runChecks(checks, runCheck);
await Deno.remove(work, { recursive: true });
console.log(
  "All model initial states and unrestricted steps passed. Every negative control produced a counterexample.",
);
