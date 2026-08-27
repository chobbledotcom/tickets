/**
 * The import-cycle report for the production module graph. A report, not a
 * gate: the tree carries known groups, so `deno task cycles` prints the
 * number to work down rather than failing on it. Run it with
 * `deno task cycles`.
 */

import { runCycleReport } from "./cycles/run.ts";

console.log(await runCycleReport());
