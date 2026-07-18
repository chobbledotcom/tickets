import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  processExists,
  runDeno,
  stopProcess,
  stopProcessNow,
} from "../../scripts/process.ts";

const stopped = (code = 0): Deno.CommandStatus => ({
  code,
  signal: null,
  success: code === 0,
});

const fakeChild = (
  onKill: (
    signal: Deno.Signal | undefined,
    finish: (status?: Deno.CommandStatus) => void,
    fail: (error?: Error) => void,
  ) => void,
) => {
  let refed = false;
  const calls: (Deno.Signal | undefined)[] = [];
  let resolveStatus: (status: Deno.CommandStatus) => void = () => {};
  let rejectStatus: (error: Error) => void = () => {};
  const status = new Promise<Deno.CommandStatus>((resolve, reject) => {
    resolveStatus = resolve;
    rejectStatus = reject;
  });
  const finish = (status = stopped()) => resolveStatus(status);
  const fail = (error = new Error("stopped")) => rejectStatus(error);
  const child = {
    kill: (signal?: Deno.Signal) => {
      calls.push(signal);
      onKill(signal, finish, fail);
    },
    ref: () => {
      refed = true;
    },
    status,
  } as unknown as Deno.ChildProcess;

  return { calls, child, refed: () => refed };
};

describe("script process helpers", () => {
  test("runs the current Deno executable", async () => {
    const result = await runDeno(["eval", "Deno.exit(7)"], Deno.cwd());

    expect(result.code).toBe(7);
    expect(result.success).toBe(false);
  });

  test("checks process liveness without spawning a shell command", () => {
    expect(processExists(Deno.pid)).toBe(true);
    expect(processExists(99_999_999)).toBe(false);
  });

  test("stops a child process gracefully and closes resources", async () => {
    let closed = false;
    const process = fakeChild((_signal, finish) => finish());

    await stopProcess(process.child, 50, () => {
      closed = true;
      return Promise.resolve();
    });

    expect(process.refed()).toBe(true);
    expect(closed).toBe(true);
    expect(process.calls).toEqual([undefined]);
  });

  test("force-stops a child process that ignores the first signal", async () => {
    const process = fakeChild((signal, _finish, fail) => {
      if (signal === "SIGKILL") fail();
    });

    await stopProcess(process.child, 1);

    expect(process.calls).toEqual([undefined, "SIGKILL"]);
  });

  test("still closes resources when the graceful signal fails", async () => {
    let closed = false;
    const child = {
      kill: () => {
        throw new Error("already stopped");
      },
      ref: () => {},
      status: Promise.resolve(stopped()),
    } as unknown as Deno.ChildProcess;

    await stopProcess(child, 50, () => {
      closed = true;
      return Promise.resolve();
    });

    expect(closed).toBe(true);
  });

  test("ignores already-stopped children in immediate stop", () => {
    const child = {
      kill: () => {
        throw new Error("already stopped");
      },
    } as unknown as Deno.ChildProcess;

    expect(() => stopProcessNow(child)).not.toThrow();
  });
});
