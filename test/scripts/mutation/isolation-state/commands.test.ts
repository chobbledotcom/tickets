import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  formatRunList,
  markFinished,
  markInterrupted,
  markRunning,
  newRunRecord,
  parseIsolationCommand,
  selectedRuns,
  visibleStatus,
} from "#scripts/mutation/isolation-state.ts";

describe("mutation isolation command parsing and listing", () => {
  test("parses management commands and passes mutation args through", () => {
    expect(parseIsolationCommand([])).toEqual({
      kind: "invalid",
      message: "Mutation source and test globs are required.",
    });
    expect(parseIsolationCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseIsolationCommand(["--list"])).toEqual({ kind: "list" });
    expect(parseIsolationCommand(["kill", "run-1", "--force"])).toEqual({
      force: true,
      kind: "kill",
      target: "run-1",
    });
    expect(parseIsolationCommand(["--kill"])).toEqual({
      kind: "invalid",
      message: "A run id or all is required for --kill.",
    });
    expect(parseIsolationCommand(["clean", "finished"])).toEqual({
      kind: "clean",
      target: "finished",
    });
    expect(parseIsolationCommand(["clean"])).toEqual({
      kind: "invalid",
      message: "A run id, all, or finished is required for --clean.",
    });
    expect(parseIsolationCommand(["src/a.ts", "test/a.test.ts"])).toEqual({
      args: ["src/a.ts", "test/a.test.ts"],
      kind: "run",
    });
  });

  test("selects records by target", () => {
    const running = markRunning(
      newRunRecord("mutation-running", ["src/a.ts"], "/repo"),
      10,
    );
    const copying = newRunRecord("mutation-copying", ["src/c.ts"], "/repo");
    const passed = markFinished(
      newRunRecord("mutation-passed", ["src/b.ts"], "/repo"),
      0,
    );
    const failed = markFinished(
      newRunRecord("mutation-failed", ["src/d.ts"], "/repo"),
      1,
    );
    const interrupted = markInterrupted(
      newRunRecord("mutation-interrupted", ["src/e.ts"], "/repo"),
    );
    const records = [running, copying, passed, failed, interrupted];

    expect(selectedRuns(records, "all").map((record) => record.id)).toEqual([
      "mutation-running",
      "mutation-copying",
      "mutation-passed",
      "mutation-failed",
      "mutation-interrupted",
    ]);
    expect(
      selectedRuns(records, "finished").map((record) => record.id),
    ).toEqual(["mutation-passed", "mutation-failed", "mutation-interrupted"]);
    expect(selectedRuns(records, "mutation-running")).toEqual([running]);
    expect(selectedRuns(records, "mutation-runn")).toEqual([running]);
    expect(selectedRuns(records, "mutation-")).toEqual([]);
    expect(selectedRuns(records, "missing")).toEqual([]);
  });

  test("formats list output", () => {
    const running = markRunning(
      newRunRecord("mutation-running", ["src/a.ts"], "/repo"),
      10,
    );

    expect(visibleStatus(running, false)).toBe("stale");
    expect(formatRunList([], new Set(), "/repo")).toEqual([
      "No isolated mutation runs.",
    ]);
    expect(
      formatRunList([running], new Set(["mutation-running"]), "/repo"),
    ).toEqual([
      "mutation-running running pid=10 exit=- work=.mutation-runs/mutation-running/work args=src/a.ts",
    ]);
    expect(formatRunList([running], new Set(), "/repo")).toEqual([
      "mutation-running stale pid=10 exit=- work=.mutation-runs/mutation-running/work args=src/a.ts",
    ]);
    expect(
      formatRunList([markFinished(running, 1)], new Set(), "/repo"),
    ).toEqual([
      "mutation-running failed pid=10 exit=1 work=.mutation-runs/mutation-running/work args=src/a.ts",
    ]);
    expect(
      formatRunList([newRunRecord("empty", [], "/repo")], new Set(), "/repo"),
    ).toEqual(["empty copying pid=- exit=- work=.mutation-runs/empty/work"]);
  });
});
