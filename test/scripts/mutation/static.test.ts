import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import type { FileMutationPlan } from "#scripts/mutation/evaluate.ts";
import type { StaticGate } from "#scripts/mutation/execution.ts";
import type { Mutant } from "#scripts/mutation/generate.ts";
import {
  defaultStaticJobs,
  evaluateStaticMutants,
  type StaticDeps,
  staticWorkerParent,
} from "#scripts/mutation/static.ts";
import { projectRoot } from "#scripts/project-root.ts";

const replacements = ["false", "null", "0", "1", "2", "3"];

const mutants = replacements.map(
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

const plan = (selected = mutants): FileMutationPlan => ({
  assets: null,
  directTestFiles: ["test/source.test.ts"],
  file: "/root/source.ts",
  mutants: selected,
  original: "true",
  rebuildTestState: false,
});

const config = (changes = {}) => ({
  abortSignal: new AbortController().signal,
  jobs: 4,
  perMutantTimeout: 1_000,
  root: "/root",
  workerParent: "/run",
  ...changes,
});

const passingGate = (exit: StaticGate["exit"]): StaticGate => ({
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

const fakeWorkspace = (): FakeWorkspace => {
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

const withStaticJobs = (value: string | null, run: () => void): void => {
  const previous = Deno.env.get("MUTATION_STATIC_JOBS");
  try {
    if (value === null) Deno.env.delete("MUTATION_STATIC_JOBS");
    else Deno.env.set("MUTATION_STATIC_JOBS", value);
    run();
  } finally {
    if (previous === undefined) Deno.env.delete("MUTATION_STATIC_JOBS");
    else Deno.env.set("MUTATION_STATIC_JOBS", previous);
  }
};

describe("parallel mutation static gates", () => {
  test("bounds isolated work and returns results in mutant order", async () => {
    const work = fakeWorkspace();
    const releases: Array<() => void> = [];
    const firstBatchStarted = Promise.withResolvers<void>();
    const active = new Set<string>();
    let maximum = 0;
    let calls = 0;
    const gate = passingGate(async (file, workspace) => {
      calls += 1;
      expect(file.startsWith(`${workspace}/`)).toBe(true);
      expect(work.files.has(file)).toBe(true);
      active.add(workspace);
      maximum = Math.max(maximum, active.size);
      if (calls <= 4) {
        if (calls === 4) firstBatchStarted.resolve();
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      active.delete(workspace);
      return 0;
    });

    const evaluated = evaluateStaticMutants(
      plan(),
      [gate],
      config({ jobs: 99 }),
      work.deps,
    );
    await firstBatchStarted.promise;
    expect(releases).toHaveLength(4);
    for (const release of releases.toReversed()) release();
    const results = await evaluated;

    expect(maximum).toBe(4);
    expect(results.map(({ mutant }) => mutant.anchor)).toEqual(
      mutants.map(({ anchor }) => anchor),
    );
    expect(work.copied).toEqual([
      "/run/static-1",
      "/run/static-2",
      "/run/static-3",
      "/run/static-4",
    ]);
    expect(work.removed).toEqual(work.copied);
    expect(new Set(work.files.keys()).size).toBe(4);
  });

  test("does not type-check a mutant rejected by lint", async () => {
    const work = fakeWorkspace();
    const typeChecked: string[] = [];
    const gates: StaticGate[] = [
      passingGate((file) =>
        Promise.resolve(work.files.get(file)?.includes("false") ? 1 : 0),
      ),
      {
        exit: (file) => {
          typeChecked.push(work.files.get(file) ?? "missing");
          return Promise.resolve(0);
        },
        label: "type-check",
        phase: "type-check",
        remedy: [],
      },
    ];

    const results = await evaluateStaticMutants(
      plan(mutants.slice(0, 3)),
      gates,
      config(),
      work.deps,
    );

    expect(results.map(({ detectedBy }) => detectedBy)).toEqual([
      "lint",
      null,
      null,
    ]);
    expect(typeChecked).toHaveLength(2);
  });

  test("aborts on a gate infrastructure error and cleans every copy", async () => {
    const work = fakeWorkspace();
    await expect(
      evaluateStaticMutants(
        plan(mutants.slice(0, 3)),
        [
          passingGate(() =>
            Promise.reject(new Error("type checker could not start")),
          ),
        ],
        config(),
        work.deps,
      ),
    ).rejects.toThrow("type checker could not start");
    expect(work.removed).toEqual(work.copied);
  });

  test("waits for every workspace copy before cleanup", async () => {
    const work = fakeWorkspace();
    const laterCopy = Promise.withResolvers<void>();
    const events: string[] = [];
    work.deps.copy = async (_from, to) => {
      events.push(`copy ${to}`);
      if (to === "/run/static-1") {
        throw new Error("copy failed");
      }
      await laterCopy.promise;
      events.push(`copied ${to}`);
    };
    work.deps.remove = (path) => {
      events.push(`removed ${path}`);
      return Promise.resolve();
    };

    const evaluated = evaluateStaticMutants(
      plan(mutants.slice(0, 3)),
      [passingGate(() => Promise.resolve(0))],
      config(),
      work.deps,
    );
    await Promise.resolve();
    expect(events).toEqual([
      "copy /run/static-1",
      "copy /run/static-2",
      "copy /run/static-3",
    ]);
    laterCopy.resolve();

    await expect(evaluated).rejects.toThrow("copy failed");
    expect(events.indexOf("copied /run/static-2")).toBeLessThan(
      events.indexOf("removed /run/static-2"),
    );
    expect(events.indexOf("copied /run/static-3")).toBeLessThan(
      events.indexOf("removed /run/static-3"),
    );
  });

  test("classifies cancellation during a gate and cleans every copy", async () => {
    const work = fakeWorkspace();
    const controller = new AbortController();
    const results = await evaluateStaticMutants(
      plan(mutants.slice(0, 3)),
      [
        passingGate(() => {
          controller.abort();
          return Promise.reject(new DOMException("Stopped", "AbortError"));
        }),
      ],
      config({ abortSignal: controller.signal }),
      work.deps,
    );
    expect(results.map(({ status }) => status)).toEqual([
      "timed-out",
      "timed-out",
      "timed-out",
    ]);
    expect(work.removed).toEqual(work.copied);
  });

  test("starts a queued mutant with its own deadline", async () => {
    const work = fakeWorkspace();
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const firstBatchStarted = Promise.withResolvers<void>();
    const queuedStarted = Promise.withResolvers<void>();
    const gate = passingGate(async (_file, _workspace, signal) => {
      signals.push(signal);
      if (signals.length === 2) firstBatchStarted.resolve();
      if (signals.length === 3) queuedStarted.resolve();
      if (signals.length <= 2) {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return 0;
    });
    const evaluated = evaluateStaticMutants(
      plan(mutants.slice(0, 3)),
      [gate],
      config({ jobs: 2 }),
      work.deps,
    );
    await firstBatchStarted.promise;
    expect(signals).toHaveLength(2);
    releases[0]?.();
    await queuedStarted.promise;
    expect(signals).toHaveLength(3);
    expect(signals[2]?.aborted).toBe(false);
    releases[1]?.();
    await evaluated;
  });

  test("uses the serial path for a tiny run", async () => {
    const work = fakeWorkspace();
    const results = await evaluateStaticMutants(
      plan(mutants.slice(0, 2)),
      [passingGate(() => Promise.resolve(0))],
      config(),
      work.deps,
    );
    expect(results).toHaveLength(2);
    expect(work.copied).toEqual([]);
    expect(work.files.get("/root/source.ts")).toBe("true");
  });

  test("uses the serial path when static work is limited to one job", async () => {
    const work = fakeWorkspace();
    const results = await evaluateStaticMutants(
      plan(mutants.slice(0, 3)),
      [passingGate(() => Promise.resolve(0))],
      config({ jobs: 1 }),
      work.deps,
    );
    expect(results).toHaveLength(3);
    expect(work.copied).toEqual([]);
  });

  test("copies real workspaces and removes them after static gates", async () => {
    const home = await Deno.makeTempDir();
    const root = join(home, "work");
    const workerParent = home;
    await Deno.mkdir(root);
    const file = join(root, "source.ts");
    await Deno.writeTextFile(file, "true");
    try {
      const results = await evaluateStaticMutants(
        { ...plan(mutants.slice(0, 3)), file },
        [
          passingGate(async (workerFile, workspace) => {
            expect(workspace).not.toBe(root);
            expect(await Deno.readTextFile(workerFile)).not.toBe("true");
            return 0;
          }),
        ],
        config({ root, workerParent }),
      );
      expect(results).toHaveLength(3);
      expect(await Deno.readTextFile(file)).toBe("true");
      await expect(Deno.stat(join(workerParent, "static-1"))).rejects.toThrow();
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });

  test("rejects a mutation target outside its workspace", async () => {
    const work = fakeWorkspace();
    await expect(
      evaluateStaticMutants(
        plan(mutants.slice(0, 1)),
        [passingGate(() => Promise.resolve(0))],
        config({ root: "/other" }),
        work.deps,
      ),
    ).rejects.toThrow("Mutation target is outside its workspace");
  });

  test("accepts worker copies already removed during cleanup", async () => {
    const work = fakeWorkspace();
    work.deps.remove = () => Promise.reject(new Deno.errors.NotFound());
    const results = await evaluateStaticMutants(
      plan(mutants.slice(0, 3)),
      [passingGate(() => Promise.resolve(0))],
      config(),
      work.deps,
    );
    expect(results).toHaveLength(3);
  });

  test("caps an explicit static worker setting at four", () => {
    withStaticJobs("20", () => {
      expect(defaultStaticJobs()).toBe(4);
    });
  });

  test("uses a bounded CPU-aware static worker default", () => {
    withStaticJobs(null, () => {
      const expected = defaultStaticJobs();
      expect(expected).toBeGreaterThanOrEqual(1);
      expect(expected).toBeLessThanOrEqual(4);
      withStaticJobs("0", () => expect(defaultStaticJobs()).toBe(expected));
    });
  });

  test("places static workers beside the mutation work copy", () => {
    expect(staticWorkerParent()).toBe(dirname(projectRoot));
  });
});
