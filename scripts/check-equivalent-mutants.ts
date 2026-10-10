#!/usr/bin/env -S deno run -A
/** Command line over `checkEquivalentMutants`, run by `deno task check:equivalents`. */

import {
  checkEquivalentMutants,
  stampForSource,
} from "#scripts/mutation/check-equivalents.ts";
import { EQUIVALENT_MUTANTS_DIR } from "#scripts/mutation/ignore.ts";
import { projectRoot } from "#scripts/project-root.ts";

const usage = `Usage: deno task check:equivalents [--stamp <source-file>...]

With no arguments, checks that every equivalent-mutant entry still points at a
real mutant. With --stamp, prints the audited:<hash> token each named source
file earns as it stands now — the token a new or re-derived entry carries.`;

const args = [...Deno.args];
let stampTargets: string[] | null = null;
if (args[0] === "--stamp") {
  args.shift();
  stampTargets = [];
  for (const path of args) {
    if (!path || path.startsWith("--")) {
      console.error(usage);
      Deno.exit(1);
    }
    stampTargets.push(path);
  }
  if (stampTargets.length === 0) {
    console.error(usage);
    Deno.exit(1);
  }
} else if (args.length > 0) {
  console.error(usage);
  Deno.exit(1);
}

if (stampTargets !== null) {
  for (const path of stampTargets) {
    console.log(`${path}: ${await stampForSource(projectRoot, path)}`);
  }
  Deno.exit(0);
}

const problems = await checkEquivalentMutants({
  registryDir: EQUIVALENT_MUTANTS_DIR,
  root: projectRoot,
});
if (problems.length === 0) {
  console.log("Every equivalent-mutant entry still points at a real mutant.");
  Deno.exit(0);
}
console.error(problems.join("\n"));
console.error(
  `\n${problems.length} equivalent-mutant entries need attention. Each names the` +
    "\nthing it sits inside; re-record it against where that code lives now, or" +
    "\nremove it if the expression is gone.",
);
Deno.exit(1);
