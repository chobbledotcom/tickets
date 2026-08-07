import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import type { StaticGate } from "#scripts/mutation/execution.ts";
import { evaluateStaticMutants } from "#scripts/mutation/static.ts";
import {
  config,
  fakeWorkspace,
  mutants,
  passingGate,
  plan,
} from "./static-helpers.ts";

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
      await expect(Deno.stat(join(workerParent, "static-1"))).rejects.toThrow(
        Deno.errors.NotFound,
      );
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
});
