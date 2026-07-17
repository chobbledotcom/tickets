import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { createMutantTestState } from "../../scripts/mutation/test-state.ts";
import { TEST_STATE_DIR_ENV } from "../../test/test-utils/test-state-env.ts";

describe("mutant test state", () => {
  const setup = (exit: number) => {
    const removed: string[] = [];
    const seenEnvs: Record<string, string>[] = [];
    let builds = 0;
    const deps = {
      makeTempDir: () => Promise.resolve("/tmp/mutant-state"),
      remove: (path: string) => {
        removed.push(path);
        return Promise.resolve();
      },
      run: (_dir: string, env: Record<string, string>) => {
        builds += 1;
        seenEnvs.push(env);
        return Promise.resolve(exit);
      },
    };
    return { builds: () => builds, deps, removed, seenEnvs };
  };

  test("builds once and returns an isolated environment with cleanup", async () => {
    const state = setup(0);
    const result = await createMutantTestState(
      { KEEP: "yes", [TEST_STATE_DIR_ENV]: "/old" },
      new AbortController().signal,
      state.deps,
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready state");
    expect(state.builds()).toBe(1);
    expect(state.seenEnvs).toEqual([{ KEEP: "yes" }]);
    expect(result.state.env).toEqual({
      KEEP: "yes",
      [TEST_STATE_DIR_ENV]: "/tmp/mutant-state",
    });
    await result.state.cleanup();
    expect(state.removed).toEqual(["/tmp/mutant-state"]);
  });

  test("removes a failed build", async () => {
    const state = setup(1);
    expect(
      await createMutantTestState({}, new AbortController().signal, state.deps),
    ).toEqual({ status: "failed" });
    expect(state.removed).toEqual(["/tmp/mutant-state"]);
  });

  test("classifies an aborted build and removes it", async () => {
    const state = setup(0);
    const controller = new AbortController();
    controller.abort();
    state.deps.run = () =>
      Promise.reject(new DOMException("Stopped", "AbortError"));
    expect(
      await createMutantTestState({}, controller.signal, state.deps),
    ).toEqual({ status: "timed-out" });
    expect(state.removed).toEqual(["/tmp/mutant-state"]);
  });

  test("classifies an abort error before its signal changes", async () => {
    const state = setup(0);
    state.deps.run = () =>
      Promise.reject(new DOMException("Stopped", "AbortError"));
    expect(
      await createMutantTestState({}, new AbortController().signal, state.deps),
    ).toEqual({ status: "timed-out" });
  });

  test("surfaces infrastructure errors after cleanup", async () => {
    const state = setup(0);
    state.deps.run = () => Promise.reject(new Error("spawn failed"));
    await expect(
      createMutantTestState({}, new AbortController().signal, state.deps),
    ).rejects.toThrow("spawn failed");
    expect(state.removed).toEqual(["/tmp/mutant-state"]);
  });

  test("runs the state builder in a fresh process and cleans its directory", async () => {
    const commands: Array<{
      command: string | URL;
      options: Deno.CommandOptions;
    }> = [];
    const fakeCommand = (
      command: string | URL,
      options: Deno.CommandOptions,
    ) => {
      commands.push({ command, options });
      return {
        output: () =>
          Promise.resolve({
            code: 0,
            signal: null,
            stderr: new Uint8Array(),
            stdout: new Uint8Array(),
            success: true,
          }),
      };
    };
    const removed: Array<{ options?: Deno.RemoveOptions; path: string | URL }> =
      [];
    using _temp = stub(Deno, "makeTempDir", () =>
      Promise.resolve("/tmp/real-mutant-state"),
    );
    using _remove = stub(Deno, "remove", (path, options) => {
      removed.push(options ? { options, path } : { path });
      return Promise.resolve();
    });
    const commandNamespace = Deno as unknown as { Command: typeof fakeCommand };
    using _command = stub(commandNamespace, "Command", fakeCommand);
    const result = await createMutantTestState(
      { KEEP: "yes", [TEST_STATE_DIR_ENV]: "/stale" },
      new AbortController().signal,
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready state");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe(Deno.execPath());
    expect(commands[0]?.options.args?.slice(0, 2)).toEqual(["run", "-A"]);
    expect(commands[0]?.options.env).toEqual({ KEEP: "yes" });
    expect(result.state.env[TEST_STATE_DIR_ENV]).toBe("/tmp/real-mutant-state");
    await result.state.cleanup();
    expect(removed).toEqual([
      { options: { recursive: true }, path: "/tmp/real-mutant-state" },
    ]);
  });
});
