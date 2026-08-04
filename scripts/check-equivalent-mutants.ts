#!/usr/bin/env -S deno run -A
/** Command line over `checkEquivalentMutants`, run by `deno task check:equivalents`. */

import {
  checkEquivalentMutants,
  DEFAULT_REGISTRY_DIR,
} from "#scripts/mutation/check-equivalents.ts";
import { projectRoot } from "#scripts/project-root.ts";

const problems = await checkEquivalentMutants({
  registryDir: DEFAULT_REGISTRY_DIR,
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
