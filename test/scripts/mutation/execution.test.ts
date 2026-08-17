import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { TEST_FILE_BATCH_SIZE } from "#scripts/mutation/batch.ts";
import {
  createStaticGates,
  mutantTestEnv,
  runTests,
  type StaticGateDeps,
  testEnv,
  toStatus,
} from "#scripts/mutation/execution.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { stripeMockPortFromEnv } from "#scripts/stripe-mock.ts";
import { captureCommands } from "#test-utils/command-capture.ts";
import { TEST_STATE_DIR_ENV } from "#test-utils/test-state-env.ts";

const config = {
  batchJobs: 1,
  env: {},
  testFiles: ["test/shared/example.test.ts"],
};

const testFilesAcrossBatches = Array.from(
  { length: TEST_FILE_BATCH_SIZE * 2 + 1 },
  (_, index) => `test/${index}.ts`,
);

const mixedMutationFiles = [
  "test/shared/example.test.ts",
  "specs/payments/example.feature",
];

const runCapturedMutation = async (
  output?: Deno.CommandOutput,
): Promise<{
  captured: ReturnType<typeof captureCommands>;
  outcome: string;
}> => {
  const captured = captureCommands(output);
  const commandNamespace = Deno as unknown as {
    Command: typeof captured.Command;
  };
  using _command = stub(commandNamespace, "Command", captured.Command);
  const result = await runTests(
    { ...config, testFiles: mixedMutationFiles },
    new AbortController().signal,
  );
  return { captured, outcome: result.outcome };
};

const runConcurrentFailure = async (
  firstBatch: (signal: AbortSignal) => Promise<number>,
): Promise<{ calls: number; outcome: string }> => {
  let calls = 0;
  const result = await runTests(
    { ...config, batchJobs: 2, testFiles: testFilesAcrossBatches },
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
    const env = testEnv(1234);

    expect(env.STRIPE_MOCK_HOST).toBe("localhost");
    expect(env.STRIPE_MOCK_PORT).toBe("1234");
  });

  test("falls back to the stripe-mock this run was told about", () => {
    expect(testEnv().STRIPE_MOCK_PORT).toBe(String(stripeMockPortFromEnv()));
  });

  test("removes stale state only when the mutant needs fresh state", () => {
    const env = { KEEP: "yes", [TEST_STATE_DIR_ENV]: "/stale" };
    expect(mutantTestEnv(env, true)).toEqual({ KEEP: "yes" });
    expect(mutantTestEnv(env, false)).toEqual(env);
  });

  test("resolves native Biome once for repeated static gates", async () => {
    const biomeCalls: Deno.CommandOptions[] = [];
    const denoCalls: Array<{ args: string[]; options: Deno.CommandOptions }> =
      [];
    let resolutions = 0;
    const deps: StaticGateDeps = {
      commandExit: (command, options) => {
        expect(command).toBe("biome");
        biomeCalls.push(options);
        return Promise.resolve(0);
      },
      denoExit: (args, options) => {
        denoCalls.push({ args, options });
        return Promise.resolve(0);
      },
      resolveBiome: (args) => {
        resolutions += 1;
        return Promise.resolve({ args, command: "biome" });
      },
    };
    const signal = new AbortController().signal;
    const gates = await createStaticGates(deps);
    expect(
      await Promise.all(
        gates.map((gate) => gate.exit("source.ts", projectRoot, signal)),
      ),
    ).toEqual([0, 0]);
    expect(await gates[0]!.exit("second.ts", projectRoot, signal)).toBe(0);
    expect(biomeCalls.map((options) => options.args)).toEqual([
      ["lint", "--error-on-warnings", "--no-errors-on-unmatched", "source.ts"],
      ["lint", "--error-on-warnings", "--no-errors-on-unmatched", "second.ts"],
    ]);
    expect(biomeCalls.map((options) => options.cwd)).toEqual(
      Array.from({ length: 2 }, () => projectRoot),
    );
    expect(denoCalls).toEqual([
      {
        args: ["check", "source.ts"],
        options: {
          cwd: projectRoot,
          signal,
          stderr: "null",
          stdout: "null",
        },
      },
    ]);
    expect(resolutions).toBe(1);
    expect(gates.map(({ label, phase }) => ({ label, phase }))).toEqual([
      { label: "lint", phase: "lint" },
      { label: "type-check", phase: "type-check" },
    ]);
  });

  test("passes the resolved Biome command prefix to lint", async () => {
    const commands: Array<{ args: string[] | undefined; command: string }> = [];
    const deps: StaticGateDeps = {
      commandExit: (command, options) => {
        commands.push({ args: options.args, command });
        return Promise.resolve(0);
      },
      denoExit: () => Promise.resolve(0),
      resolveBiome: (args) =>
        Promise.resolve({
          args: ["run", "-A", "npm:@biomejs/biome@2.4.16", ...args],
          command: Deno.execPath(),
        }),
    };
    const gates = await createStaticGates(deps);
    const lint = gates[0];
    if (!lint) throw new Error("Expected lint gate");
    await lint.exit("source.ts", projectRoot, new AbortController().signal);

    expect(commands).toEqual([
      {
        args: [
          "run",
          "-A",
          "npm:@biomejs/biome@2.4.16",
          "lint",
          "--error-on-warnings",
          "--no-errors-on-unmatched",
          "source.ts",
        ],
        command: Deno.execPath(),
      },
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

  test("runs Cucumber Features after direct mutation tests", async () => {
    const result = await runCapturedMutation();
    expect(result.outcome).toBe("passed");
    expect(result.captured.commands.map(({ options }) => options.args)).toEqual(
      [
        [
          "test",
          "--no-check",
          "--allow-all",
          "--parallel",
          "--preload",
          "./test/test-utils/preload.ts",
          "--v8-flags=--expose-gc",
          "test/shared/example.test.ts",
        ],
        [
          "run",
          "--v8-flags=--expose-gc",
          "-A",
          "./scripts/run-specs.ts",
          "specs/payments/example.feature",
        ],
      ],
    );
  });

  test("runs all Features once after concurrent direct batches", async () => {
    const features = ["specs/a.feature", "specs/b.feature"];
    const batches: string[][] = [];
    const result = await runTests(
      {
        ...config,
        batchJobs: 2,
        testFiles: [...testFilesAcrossBatches, ...features],
      },
      new AbortController().signal,
      {
        runBatch: (batch) => {
          batches.push(batch);
          return Promise.resolve(0);
        },
      },
    );

    expect(result.outcome).toBe("passed");
    expect(batches.slice(0, -1).flat()).toEqual(testFilesAcrossBatches);
    expect(batches.at(-1)).toEqual(features);
  });

  test("does not run Cucumber after a direct mutation test fails", async () => {
    const result = await runCapturedMutation({
      code: 1,
      signal: null,
      stderr: new Uint8Array(),
      stdout: new Uint8Array(),
      success: false,
    });
    expect(result.outcome).toBe("failed");
    expect(result.captured.commands).toHaveLength(1);
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
    ).toEqual({ durationMs: expect.any(Number), outcome: "cancelled" });
  });

  test("classifies a subprocess error after its deadline aborts", async () => {
    const controller = new AbortController();
    const result = await runTests(config, controller.signal, {
      runBatch: () => {
        controller.abort();
        return Promise.reject(new DOMException("Stopped", "AbortError"));
      },
    });
    expect(result.outcome).toBe("cancelled");
  });

  test("stops before another batch when the deadline expires", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await runTests(
      { ...config, testFiles: testFilesAcrossBatches },
      controller.signal,
      {
        runBatch: () => {
          calls += 1;
          controller.abort();
          return Promise.resolve(0);
        },
      },
    );
    expect(result.outcome).toBe("cancelled");
    expect(calls).toBe(1);
  });

  test("stops before another batch after a non-zero test exit", async () => {
    let calls = 0;
    expect(
      await runTests(
        { ...config, testFiles: testFilesAcrossBatches },
        new AbortController().signal,
        {
          runBatch: () => {
            calls += 1;
            return Promise.resolve(1);
          },
        },
      ),
    ).toEqual({ durationMs: expect.any(Number), outcome: "failed" });
    expect(calls).toBe(1);
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
      toStatus("cancelled"),
    ]).toEqual(["survived", "killed", "cancelled"]);
  });
});
