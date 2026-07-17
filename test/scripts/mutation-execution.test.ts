import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  createStaticGates,
  mutantTestEnv,
  runTests,
  type StaticGateDeps,
  testEnv,
  toStatus,
} from "../../scripts/mutation/execution.ts";
import { projectRoot } from "../../scripts/project-root.ts";
import { captureCommands } from "../../test/test-utils/command-capture.ts";
import { TEST_STATE_DIR_ENV } from "../../test/test-utils/test-state-env.ts";

const config = {
  batchJobs: 1,
  env: {},
  testFiles: ["test/shared/example.test.ts"],
};

const runConcurrentFailure = async (
  firstBatch: (signal: AbortSignal) => Promise<number>,
): Promise<{ calls: number; outcome: string }> => {
  let calls = 0;
  const testFiles = Array.from(
    { length: 25 },
    (_, index) => `test/${index}.ts`,
  );
  const result = await runTests(
    { ...config, batchJobs: 2, testFiles },
    new AbortController().signal,
    {
      runBatch: (_batch, signal) => {
        calls += 1;
        return calls === 2 ? Promise.resolve(1) : firstBatch(signal);
      },
    },
  );
  return { calls, outcome: result.outcome };
};

describe("mutation test execution", () => {
  test("builds the mutation child environment from current Stripe settings", () => {
    const previousPort = Deno.env.get("STRIPE_MOCK_PORT");
    Deno.env.set("STRIPE_MOCK_PORT", "1234");
    try {
      const env = testEnv();
      expect(env.STRIPE_MOCK_HOST).toBe("localhost");
      expect(env.STRIPE_MOCK_PORT).toBe("1234");
    } finally {
      if (previousPort) Deno.env.set("STRIPE_MOCK_PORT", previousPort);
      else Deno.env.delete("STRIPE_MOCK_PORT");
    }
  });

  test("removes stale state only when the mutant needs fresh state", () => {
    const env = { KEEP: "yes", [TEST_STATE_DIR_ENV]: "/stale" };
    expect(mutantTestEnv(env, true)).toEqual({ KEEP: "yes" });
    expect(mutantTestEnv(env, false)).toEqual(env);
  });

  test("creates native Biome and Deno static gates", async () => {
    const calls: unknown[][] = [];
    const deps: StaticGateDeps = {
      commandExit: (command, options) => {
        calls.push([command, options]);
        return Promise.resolve(0);
      },
      denoExit: (args, options) => {
        calls.push([args, options]);
        return Promise.resolve(0);
      },
      whichBiome: () => Promise.resolve(true),
    };
    const signal = new AbortController().signal;
    const gates = await createStaticGates(deps);
    expect(
      await Promise.all(gates.map((gate) => gate.exit("source.ts", signal))),
    ).toEqual([0, 0]);
    expect(calls).toEqual([
      [
        "biome",
        {
          args: ["lint", "--no-errors-on-unmatched", "source.ts"],
          cwd: projectRoot,
          signal,
          stderr: "null",
          stdout: "null",
        },
      ],
      [
        ["check", "source.ts"],
        {
          cwd: projectRoot,
          signal,
          stderr: "null",
          stdout: "null",
        },
      ],
    ]);
    expect(gates.map(({ label, phase }) => ({ label, phase }))).toEqual([
      { label: "lint", phase: "lint" },
      { label: "type-check", phase: "type-check" },
    ]);
  });

  test("falls back to packaged Biome when native lookup cannot find it", async () => {
    const commands: Array<{ args: string[] | undefined; command: string }> = [];
    const deps = (whichBiome: () => Promise<boolean>): StaticGateDeps => ({
      commandExit: (command, options) => {
        commands.push({ args: options.args, command });
        return Promise.resolve(0);
      },
      denoExit: () => Promise.resolve(0),
      whichBiome,
    });
    for (const whichBiome of [
      () => Promise.resolve(false),
      () => Promise.reject(new Error("which unavailable")),
    ]) {
      const gates = await createStaticGates(deps(whichBiome));
      const lint = gates[0];
      if (!lint) throw new Error("Expected lint gate");
      await lint.exit("source.ts", new AbortController().signal);
    }
    expect(commands).toEqual(
      Array.from({ length: 2 }, () => ({
        args: [
          "run",
          "-A",
          "npm:@biomejs/biome",
          "lint",
          "--no-errors-on-unmatched",
          "source.ts",
        ],
        command: Deno.execPath(),
      })),
    );
  });

  test("finds the static gate tools available to the running process", async () => {
    expect((await createStaticGates()).map(({ label }) => label)).toEqual([
      "lint",
      "type-check",
    ]);
  });

  test("runs the default Deno test command with the mutation flags", async () => {
    const captured = captureCommands();
    const commandNamespace = Deno as unknown as {
      Command: typeof captured.Command;
    };
    using _command = stub(commandNamespace, "Command", captured.Command);
    expect((await runTests(config, new AbortController().signal)).outcome).toBe(
      "passed",
    );
    expect(captured.commands[0]?.command).toBe(Deno.execPath());
    expect(captured.commands[0]?.options.args).toEqual([
      "test",
      "--no-check",
      "--allow-all",
      "--parallel",
      "--preload",
      "./test/test-utils/preload.ts",
      "--v8-flags=--expose-gc",
      "test/shared/example.test.ts",
    ]);
  });

  test("surfaces subprocess infrastructure failures", async () => {
    await expect(
      runTests(config, new AbortController().signal, {
        runBatch: () => Promise.reject(new Error("spawn failed")),
      }),
    ).rejects.toThrow("spawn failed");
  });

  test("classifies an aborted subprocess as timed out", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await runTests(config, controller.signal, {
        runBatch: () =>
          Promise.reject(new DOMException("Stopped", "AbortError")),
      }),
    ).toEqual({ durationMs: expect.any(Number), outcome: "timed-out" });
  });

  test("classifies a subprocess error after its deadline aborts", async () => {
    const controller = new AbortController();
    const result = await runTests(config, controller.signal, {
      runBatch: () => {
        controller.abort();
        return Promise.reject(new DOMException("Stopped", "AbortError"));
      },
    });
    expect(result.outcome).toBe("timed-out");
  });

  test("stops before another batch when the deadline expires", async () => {
    const controller = new AbortController();
    const result = await runTests(config, controller.signal, {
      runBatch: () => {
        controller.abort();
        return Promise.resolve(0);
      },
    });
    expect(result.outcome).toBe("timed-out");
  });

  test("classifies a non-zero test exit as failed", async () => {
    expect(
      await runTests(config, new AbortController().signal, {
        runBatch: () => Promise.resolve(1),
      }),
    ).toEqual({ durationMs: expect.any(Number), outcome: "failed" });
  });

  test("stops concurrent batches after the first test failure", async () => {
    const result = await runConcurrentFailure(
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Stopped", "AbortError")),
            { once: true },
          ),
        ),
    );
    expect(result).toEqual({ calls: 2, outcome: "failed" });
  });

  test("accepts a concurrent batch that finishes while another fails", async () => {
    const result = await runConcurrentFailure(
      (signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve(0), { once: true }),
        ),
    );
    expect(result).toEqual({ calls: 2, outcome: "failed" });
  });

  test("maps every process outcome to its mutation status", () => {
    expect([
      toStatus("passed"),
      toStatus("failed"),
      toStatus("timed-out"),
    ]).toEqual(["survived", "killed", "timed-out"]);
  });
});
