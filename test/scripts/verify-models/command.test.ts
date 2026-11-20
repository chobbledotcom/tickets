// test-groups: run-alone
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { prepareArgs } from "#scripts/verify-models/jobs.ts";
import { COMMAND_TIMEOUT_MS, outputOf } from "#scripts/verify-models/run.ts";
import {
  stubChildProcess,
  stubDenoCommand,
} from "#test-utils/command-capture.ts";

const result = (success: boolean): Deno.CommandOutput => ({
  code: success ? 0 : 1,
  signal: null,
  stderr: new TextEncoder().encode("checker detail"),
  stdout: new TextEncoder().encode(
    "Safety violated. Check the trace in: trace.json\n",
  ),
  success,
});

const neverEndingChild = (
  ended: Promise<Deno.CommandOutput>,
  kill: (signal?: Deno.Signal) => void,
) =>
  stubChildProcess({
    kill,
    output: () => ended,
    ref: () => {},
    status: ended,
  });

const stalledChild = (
  onKill: (
    signal: Deno.Signal | undefined,
    ended: PromiseWithResolvers<Deno.CommandOutput>,
  ) => void,
) => {
  const signals: (Deno.Signal | undefined)[] = [];
  const ended = Promise.withResolvers<Deno.CommandOutput>();
  const child = neverEndingChild(ended.promise, (signal) => {
    signals.push(signal);
    onKill(signal, ended);
  });
  return { child, signals };
};

const stalledCommand = (ignoreTerm: boolean) => {
  const { child, signals } = stalledChild((signal, ended) => {
    if (!ignoreTerm || signal === "SIGKILL") ended.resolve(result(false));
  });
  return { Command: () => ({ spawn: () => child }), signals };
};

describe("model child commands", () => {
  test("exposes garbage collection in each producer child", () => {
    expect(prepareArgs("Payments", "/work")).toEqual([
      "run",
      "--v8-flags=--expose-gc",
      "-A",
      "scripts/verify-models.ts",
      "--prepare",
      "Payments",
      "/work",
    ]);
  });

  for (const [kind, timeoutMs] of Object.entries(COMMAND_TIMEOUT_MS)) {
    test(`stops a stalled ${kind} at its deadline and keeps its output`, async () => {
      using time = new FakeTime();
      const command = stalledCommand(false);
      using _command = stubDenoCommand(command.Command);
      const pending = outputOf("checker", ["check"], "/work", timeoutMs);
      const rejected = expect(pending).rejects.toThrow(
        `checker timed out after ${timeoutMs / 1000} seconds. Read /work.\nSafety violated. Check the trace in: trace.json\nchecker detail`,
      );
      await time.tickAsync(timeoutMs - 1);
      expect(command.signals).toEqual([]);
      await time.tickAsync(1);
      await rejected;
      expect(command.signals).toEqual([undefined]);
    });
  }

  test("force-stops a child that ignores the first signal", async () => {
    using time = new FakeTime();
    const command = stalledCommand(true);
    using _command = stubDenoCommand(command.Command);
    const rejected = expect(
      outputOf("checker", [], "/work", 10),
    ).rejects.toThrow("checker timed out after 0.01 seconds.");
    await time.tickAsync(10);
    expect(command.signals).toEqual([undefined]);
    await time.tickAsync(5_000);
    await rejected;
    expect(command.signals).toEqual([undefined, "SIGKILL"]);
  });

  test("fails if a child does not exit after the forced stop", async () => {
    using time = new FakeTime();
    const { child, signals } = stalledChild(() => {});
    using _command = stubDenoCommand(() => ({ spawn: () => child }));
    const rejected = expect(
      outputOf("checker", [], "/work", 10),
    ).rejects.toThrow("child process did not exit after SIGKILL within 5000ms");
    await time.tickAsync(10);
    await time.tickAsync(5_000);
    await time.tickAsync(5_000);
    await rejected;
    expect(signals).toEqual([undefined, "SIGKILL"]);
  });

  for (const success of [true, false]) {
    test(`keeps an ordinary ${success ? "pass" : "failure"} and clears its deadline`, async () => {
      using time = new FakeTime();
      const signals: (Deno.Signal | undefined)[] = [];
      const child = stubChildProcess({
        kill: (signal) => {
          signals.push(signal);
        },
        output: () => Promise.resolve(result(success)),
      });
      using _command = stubDenoCommand(() => ({ spawn: () => child }));
      expect(await outputOf("checker", [], "/work", 10)).toEqual({
        output:
          "Safety violated. Check the trace in: trace.json\nchecker detail",
        success,
      });
      await time.tickAsync(10);
      expect(signals).toEqual([]);
    });
  }

  test("propagates a failure to start the child", async () => {
    const error = new Error("cannot start checker");
    using _command = stubDenoCommand(() => ({
      spawn: () => {
        throw error;
      },
    }));
    await expect(outputOf("checker", [], "/work", 10)).rejects.toBe(error);
  });
});
