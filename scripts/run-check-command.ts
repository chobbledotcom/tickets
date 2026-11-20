import type { CheckOutput } from "#scripts/check-report.ts";
import { rejectArgs, runDenoScript } from "#scripts/script-runner.ts";

/** Run one repository check command with the standard argument rule. */
export const runCheckCommand = (
  task: string,
  check: (output: CheckOutput) => Promise<number>,
): Promise<never> =>
  runDenoScript(async (io) => {
    const usage = rejectArgs(io, task);
    if (usage !== undefined) return usage;
    return await check({ log: io.stdout, logError: io.stderr });
  });
