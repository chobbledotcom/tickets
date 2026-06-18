import { filterTestOutput, testProgressFromLine } from "./output.ts";

export interface Step {
  cmd: string[];
  filterOutput?: (stdout: string, stderr: string) => string;
  progress?: (line: string) => string | undefined;
  name: string;
}

export const getSteps = (ci: boolean): Step[] => {
  return [
    // Dev runs the auto-fixing `lint` (Biome `check --write`). CI runs the
    // read-only `lint:ci`, which fails when code *would* be reformatted or has
    // a lint warning - catching unformatted code without modifying the checkout
    // or requiring a clean working tree.
    { cmd: ["deno", "task", ci ? "lint:ci" : "lint"], name: "lint" },
    { cmd: ["deno", "task", "typecheck"], name: "typecheck" },
    { cmd: ["deno", "task", "cpd"], name: "cpd" },
    { cmd: ["deno", "task", "build:edge"], name: "build:edge" },
    {
      cmd: ["deno", "task", "test:coverage"],
      filterOutput: filterTestOutput,
      name: "test:coverage",
      progress: testProgressFromLine,
    },
  ];
};
