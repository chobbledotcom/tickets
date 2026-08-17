import type { FileMutationPlan } from "#scripts/mutation/evaluate.ts";
import type { StaticGate } from "#scripts/mutation/execution.ts";
import type { Mutant } from "#scripts/mutation/generate.ts";
import type { evaluateStaticMutants } from "#scripts/mutation/static.ts";

type StaticRunConfig = Parameters<typeof evaluateStaticMutants>[2];
type StaticDeps = NonNullable<Parameters<typeof evaluateStaticMutants>[3]>;

const replacements = ["false", "null", "0", "1", "2", "3"];

export const mutants = replacements.map(
  (newOperator, index): Mutant => ({
    anchor: `mutant-${index}`,
    column: 1,
    end: 4,
    line: 1,
    newOperator,
    operator: "true",
    start: 0,
  }),
);

export const plan = (selected = mutants): FileMutationPlan => ({
  assets: null,
  directTestFiles: ["test/source.test.ts"],
  file: "/root/source.ts",
  mutants: selected,
  original: "true",
  rebuildTestState: false,
});

export const config = (
  changes: Partial<StaticRunConfig> = {},
): StaticRunConfig => ({
  abortSignal: new AbortController().signal,
  jobs: 4,
  root: "/root",
  workerParent: "/run",
  ...changes,
});

export const passingGate = (exit: StaticGate["exit"]): StaticGate => ({
  exit,
  label: "lint",
  phase: "lint",
  remedy: [],
});

interface FakeWorkspace {
  copied: string[];
  deps: StaticDeps;
  files: Map<string, string>;
  removed: string[];
}

export const fakeWorkspace = (): FakeWorkspace => {
  const copied: string[] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  return {
    copied,
    deps: {
      copy: (_from, to) => {
        copied.push(to);
        return Promise.resolve();
      },
      now: performance.now.bind(performance),
      remove: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
      write: (file, content) => {
        files.set(file, content);
        return Promise.resolve();
      },
    },
    files,
    removed,
  };
};
