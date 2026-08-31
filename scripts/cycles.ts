/**
 * The import-cycle report for the production module graph. A report, not a
 * gate: the tree carries known groups, so this prints the number to work
 * down rather than failing on it.
 */

import { runCycleReport } from "./cycles/run.ts";

console.log(await runCycleReport());
