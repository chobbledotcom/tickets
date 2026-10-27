import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { holds, stubRun } from "#test-utils/git-stub.ts";

describe("stubRun", () => {
  test("answers a mapped command with its captured output", async () => {
    const run = stubRun({ "git show HEAD:deno.json": holds("deno.json") });

    const captured = await run(["git", "show", "HEAD:deno.json"]);

    expect(captured.success).toBe(true);
    expect(captured.stderr).toBe("");
    expect(captured.stdout).toBe("100644 blob abc123\tdeno.json\n");
  });

  test("maps a nonzero exit code to a failed command", async () => {
    const run = stubRun({
      "git show HEAD:nope.json": {
        code: 128,
        stderr: "fatal: path 'nope.json' does not exist",
        stdout: "",
      },
    });

    const captured = await run(["git", "show", "HEAD:nope.json"]);

    expect(captured.success).toBe(false);
    expect(captured.stderr).toBe("fatal: path 'nope.json' does not exist");
  });

  test("rejects a command the stub does not answer", async () => {
    const run = stubRun({});

    await expect(run(["git", "status", "--porcelain"])).rejects.toThrow(
      "unexpected command: git status --porcelain",
    );
  });
});
