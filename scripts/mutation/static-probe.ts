/**
 * Probe that the *unmutated* target passes every static gate before its mutants
 * run, and report loudly if not. A gate can only tell a mutation-introduced
 * diagnostic apart from a broken tool or an already-dirty target if the
 * unmutated file passes it. The file on disk is the original here (restored
 * after every mutant), so probe it once per file per gate — the type-check
 * probe also warms the module cache, so the file's per-mutant `deno check`s
 * re-type only the one changed file. A non-zero exit means that gate can't be
 * trusted — precommit typechecks and runs `lint:ci` before mutation, but a
 * standalone `deno task mutation` does not — so the caller aborts rather than
 * record every mutant as a bogus static kill. Probing the target itself (not a
 * fixed path) also means a run that mutates this very file never reprobes a
 * path that is currently holding a mutant.
 */

import { red } from "#scripts/precommit/colors.ts";
import { projectRoot, rel } from "#scripts/project-root.ts";
import type { FileMutationPlan } from "./evaluate.ts";
import type { StaticGate } from "./execution.ts";

export const isUnmutatedTargetDirty = async (
  plan: FileMutationPlan,
  gates: StaticGate[],
  signal: AbortSignal,
): Promise<boolean> => {
  if (plan.mutants.length === 0) return false;
  for (const gate of gates) {
    const exit = await gate.exit(plan.file, projectRoot, signal);
    // A gate the guard or an interrupt killed exited non-zero because it was
    // stopped, which says nothing about the file. Calling that a dirty target
    // would send someone off to fix a file that was never the problem.
    if (signal.aborted) return false;
    if (exit === 0) continue;
    console.error(
      red(
        `\nThe unmutated ${rel(plan.file)} does not pass the ${gate.label} gate.`,
      ),
    );
    for (const line of gate.remedy) console.error(line);
    return true;
  }
  return false;
};
