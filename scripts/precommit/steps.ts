import { filterTestOutput, testProgressFromLine } from "./output.ts";

export interface Step {
  cmd: string[];
  filterOutput?: (stdout: string, stderr: string) => string;
  progress?: (line: string) => string | undefined;
  name: string;
}

export const getSteps = (): Step[] => {
  const deno = Deno.execPath();
  return [
    // Always run the read-only `lint:ci` (Biome `check --error-on-warnings`) so
    // precommit is exactly as strict locally as in CI: it fails on lint warnings
    // and on code that *would* be reformatted, without modifying the checkout.
    // Run `deno task lint` separately to auto-fix formatting before committing.
    { cmd: [deno, "task", "lint:ci"], name: "lint" },
    { cmd: [deno, "task", "typecheck"], name: "typecheck" },
    { cmd: [deno, "task", "cpd"], name: "cpd" },
    { cmd: [deno, "task", "build:edge"], name: "build:edge" },
    {
      cmd: [deno, "task", "test:coverage"],
      filterOutput: filterTestOutput,
      name: "test:coverage",
      progress: testProgressFromLine,
    },
  ];
};
