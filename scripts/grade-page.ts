// Run via `deno task grade:page`, which grants read, env, and net access.

import { runDenoScript } from "#scripts/script-runner.ts";
import { runGradePageCli } from "./grade-page/cli.ts";

await runDenoScript(runGradePageCli);
