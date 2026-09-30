// Run via `deno task grade:code`, which grants read, env, and net access.

import { runDenoScript } from "#scripts/script-runner.ts";
import { runGradeCodeCli } from "./grade-code/cli.ts";

await runDenoScript(runGradeCodeCli);
