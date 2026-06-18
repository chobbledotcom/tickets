import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CommandResult,
  getMergeConflictWarning,
  parseMergeTreeConflictedPaths,
  runCommand,
  runInteractiveCommand,
} from "../../scripts/precommit/merge-warning.ts";
import {
  formatPushPrompt,
  getPushPromptContext,
  promptToPushCheckedInChanges,
  shouldPushFromAnswer,
} from "../../scripts/precommit/push.ts";
import {
  canPrompt,
  canShowProgress,
  currentTerminalState,
} from "../../scripts/precommit/terminal.ts";

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stderr: "",
  stdout,
  success: true,
});

const fail = (code: number, stdout = "", stderr = ""): CommandResult => ({
  code,
  stderr,
  stdout,
  success: false,
});

describe("precommit merge conflict warning", () => {
  test("parses conflicted paths from git merge-tree output", () => {
    const paths = parseMergeTreeConflictedPaths(
      [
        "5e89402821f6b187f36361df2f18c6db18d384a3",
        "src/a.ts",
        "src/b.ts",
        "",
        "Auto-merging src/a.ts",
        "CONFLICT (content): Merge conflict in src/a.ts",
      ].join("\n"),
    );

    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("returns a warning when origin main has merge conflicts", async () => {
    const responses = [
      ok("true\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("cccccccccccccccccccccccccccccccccccccccc\n"),
      ok("dddddddddddddddddddddddddddddddddddddddd\n"),
      fail(
        1,
        [
          "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          "src/a.ts",
          "src/b.ts",
          "",
          "Auto-merging src/a.ts",
          "CONFLICT (content): Merge conflict in src/a.ts",
        ].join("\n"),
      ),
    ];
    const calls: string[][] = [];
    const run = (cmd: string[]): Promise<CommandResult> => {
      calls.push(cmd);
      return Promise.resolve(responses.shift() ?? fail(128));
    };

    const warning = await getMergeConflictWarning(run);

    expect(warning).toBe(
      "Heads up - this branch has 2 merge conflicts against git@github.com:chobbledotcom/tickets.git",
    );
    expect(calls.at(-1)).toEqual([
      "git",
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--merge-base",
      "cccccccccccccccccccccccccccccccccccccccc",
      "dddddddddddddddddddddddddddddddddddddddd",
      "origin/main",
    ]);
  });

  test("uses the requested warning wording for one conflicted path", async () => {
    const responses = [
      ok("true\n"),
      ok("https://github.com/chobbledotcom/tickets.git\n"),
      ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("cccccccccccccccccccccccccccccccccccccccc\n"),
      ok("dddddddddddddddddddddddddddddddddddddddd\n"),
      fail(
        1,
        [
          "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          "src/a.ts",
          "",
          "Auto-merging src/a.ts",
          "CONFLICT (content): Merge conflict in src/a.ts",
        ].join("\n"),
      ),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getMergeConflictWarning(run)).resolves.toBe(
      "Heads up - this branch has 1 merge conflicts against https://github.com/chobbledotcom/tickets.git",
    );
  });

  test("does not warn when origin main merges cleanly", async () => {
    const responses = [
      ok("true\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("cccccccccccccccccccccccccccccccccccccccc\n"),
      ok("dddddddddddddddddddddddddddddddddddddddd\n"),
      ok("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getMergeConflictWarning(run)).resolves.toBeUndefined();
  });

  test("does not warn when required git metadata commands fail", async () => {
    const responses = [
      ok("true\n"),
      fail(128, "", "fatal: no such remote 'origin'\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getMergeConflictWarning(run)).resolves.toBeUndefined();
  });

  test("does not warn when required git metadata is blank", async () => {
    const responses = [
      ok("true\n"),
      ok("\n"),
      ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("cccccccccccccccccccccccccccccccccccccccc\n"),
      ok("dddddddddddddddddddddddddddddddddddddddd\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getMergeConflictWarning(run)).resolves.toBeUndefined();
  });

  test("does not warn when merge-tree cannot complete the check", async () => {
    const responses = [
      ok("true\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("cccccccccccccccccccccccccccccccccccccccc\n"),
      ok("dddddddddddddddddddddddddddddddddddddddd\n"),
      fail(128, "", "fatal: failure to merge\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getMergeConflictWarning(run)).resolves.toBeUndefined();
  });

  test("does not warn when merge-tree reports no conflicted paths", async () => {
    const responses = [
      ok("true\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
      ok("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"),
      ok("cccccccccccccccccccccccccccccccccccccccc\n"),
      ok("dddddddddddddddddddddddddddddddddddddddd\n"),
      fail(1, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getMergeConflictWarning(run)).resolves.toBeUndefined();
  });

  test("does not warn outside a git work tree", async () => {
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(fail(128, "", "fatal: not a git repository\n"));

    await expect(getMergeConflictWarning(run)).resolves.toBeUndefined();
  });

  test("runs commands and captures output", async () => {
    await expect(
      runCommand(["deno", "eval", "console.log('merge-warning')"]),
    ).resolves.toEqual({
      code: 0,
      stderr: "",
      stdout: "merge-warning\n",
      success: true,
    });
  });

  test("rejects an empty command", async () => {
    await expect(runCommand([])).rejects.toThrow("No command configured");
  });

  test("runs interactive commands", async () => {
    await expect(runInteractiveCommand(["deno", "eval", ""])).resolves.toEqual({
      code: 0,
      stderr: "",
      stdout: "",
      success: true,
    });
  });

  test("rejects an empty interactive command", async () => {
    await expect(runInteractiveCommand([])).rejects.toThrow(
      "No command configured",
    );
  });
});

describe("precommit terminal behavior", () => {
  test("shows progress in git hooks where stdout is a terminal but stdin is not", () => {
    const hookTerminalState = { ci: false, stdin: false, stdout: true };

    expect(canShowProgress(hookTerminalState)).toBe(true);
    expect(canPrompt(hookTerminalState)).toBe(false);
  });

  test("does not show progress or prompt in CI", () => {
    const ciTerminalState = { ci: true, stdin: true, stdout: true };

    expect(canShowProgress(ciTerminalState)).toBe(false);
    expect(canPrompt(ciTerminalState)).toBe(false);
  });

  test("reads the current terminal state", () => {
    const state = currentTerminalState();

    expect(typeof state.ci).toBe("boolean");
    expect(typeof state.stdin).toBe("boolean");
    expect(typeof state.stdout).toBe("boolean");
  });
});

describe("precommit push prompt", () => {
  test("builds prompt context for a clean branch with unpushed commits", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Ship the hook\n\nBody\n"),
      ok("origin/feature\n"),
      ok("2\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("feature\n"),
    ];
    const calls: string[][] = [];
    const run = (cmd: string[]): Promise<CommandResult> => {
      calls.push(cmd);
      return Promise.resolve(responses.shift() ?? fail(128));
    };

    await expect(getPushPromptContext(run)).resolves.toEqual({
      branchName: "feature",
      commitMessage: "Ship the hook\n\nBody",
      originUrl: "git@github.com:chobbledotcom/tickets.git",
      unpushedCommits: 2,
    });
    expect(calls).toEqual([
      ["git", "rev-parse", "--is-inside-work-tree"],
      ["git", "status", "--porcelain"],
      ["git", "log", "-1", "--format=%B"],
      [
        "git",
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ],
      ["git", "rev-list", "--count", "origin/feature..HEAD"],
      ["git", "remote", "get-url", "origin"],
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    ]);
  });

  test("uses origin main as a fallback when no upstream exists", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Ship local branch\n"),
      fail(128),
      ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
      ok("1\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("feature\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getPushPromptContext(run)).resolves.toEqual({
      branchName: "feature",
      commitMessage: "Ship local branch",
      originUrl: "git@github.com:chobbledotcom/tickets.git",
      unpushedCommits: 1,
    });
  });

  test("assumes one unpushed commit when no comparison ref exists", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Initial branch commit\n"),
      fail(128),
      fail(128),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("feature\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getPushPromptContext(run)).resolves.toEqual({
      branchName: "feature",
      commitMessage: "Initial branch commit",
      originUrl: "git@github.com:chobbledotcom/tickets.git",
      unpushedCommits: 1,
    });
  });

  test("does not build context outside a git work tree", async () => {
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(fail(128));

    await expect(getPushPromptContext(run)).resolves.toBeUndefined();
  });

  test("does not build context when the worktree is dirty", async () => {
    const responses = [ok("true\n"), ok(" M scripts/precommit.ts\n")];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getPushPromptContext(run)).resolves.toBeUndefined();
  });

  test("does not build context when there is no commit message", async () => {
    const responses = [ok("true\n"), ok(""), ok("\n")];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getPushPromptContext(run)).resolves.toBeUndefined();
  });

  test("does not build context when there are no unpushed commits", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Already pushed\n"),
      ok("origin/feature\n"),
      ok("0\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getPushPromptContext(run)).resolves.toBeUndefined();
  });

  test("does not build context when unpushed count is blank", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Blank count\n"),
      ok("origin/feature\n"),
      ok("\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getPushPromptContext(run)).resolves.toBeUndefined();
  });

  test("does not build context when unpushed count is invalid", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Bad count\n"),
      ok("origin/feature\n"),
      ok("many\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getPushPromptContext(run)).resolves.toBeUndefined();
  });

  test("does not build context without an origin remote", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("No origin\n"),
      ok("origin/feature\n"),
      ok("1\n"),
      fail(128),
      ok("feature\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getPushPromptContext(run)).resolves.toBeUndefined();
  });

  test("does not build context for a detached head", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Detached\n"),
      ok("origin/feature\n"),
      ok("1\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("HEAD\n"),
    ];
    const run = (_cmd: string[]): Promise<CommandResult> =>
      Promise.resolve(responses.shift() ?? fail(128));

    await expect(getPushPromptContext(run)).resolves.toBeUndefined();
  });

  test("formats push prompts with commit counts and subjects", () => {
    expect(
      formatPushPrompt({
        branchName: "feature",
        commitMessage: "Ship the hook\n\nBody",
        originUrl: "git@github.com:chobbledotcom/tickets.git",
        unpushedCommits: 2,
      }),
    ).toBe(
      "Push 2 commits from feature to git@github.com:chobbledotcom/tickets.git? (Ship the hook) [y/N] ",
    );
    expect(
      formatPushPrompt({
        branchName: "feature",
        commitMessage: "",
        originUrl: "git@github.com:chobbledotcom/tickets.git",
        unpushedCommits: 1,
      }),
    ).toBe(
      "Push 1 commit from feature to git@github.com:chobbledotcom/tickets.git? [y/N] ",
    );
  });

  test("accepts only explicit yes answers", () => {
    expect(shouldPushFromAnswer("y\n")).toBe(true);
    expect(shouldPushFromAnswer("YES")).toBe(true);
    expect(shouldPushFromAnswer("no")).toBe(false);
    expect(shouldPushFromAnswer("")).toBe(false);
  });

  test("skips pushing when not interactive", async () => {
    let pushed = false;

    await expect(
      promptToPushCheckedInChanges({
        confirm: () => Promise.resolve(true),
        isInteractive: () => false,
        push: () => {
          pushed = true;
          return Promise.resolve(ok());
        },
        run: () => Promise.resolve(fail(128)),
      }),
    ).resolves.toBe(true);
    expect(pushed).toBe(false);
  });

  test("skips pushing when there is no prompt context", async () => {
    let pushed = false;

    await expect(
      promptToPushCheckedInChanges({
        confirm: () => Promise.resolve(true),
        isInteractive: () => true,
        push: () => {
          pushed = true;
          return Promise.resolve(ok());
        },
        run: () => Promise.resolve(fail(128)),
      }),
    ).resolves.toBe(true);
    expect(pushed).toBe(false);
  });

  test("skips pushing when the user declines", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Ready\n"),
      ok("origin/feature\n"),
      ok("1\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("feature\n"),
    ];
    let pushed = false;

    await expect(
      promptToPushCheckedInChanges({
        confirm: () => Promise.resolve(false),
        isInteractive: () => true,
        push: () => {
          pushed = true;
          return Promise.resolve(ok());
        },
        run: () => Promise.resolve(responses.shift() ?? fail(128)),
      }),
    ).resolves.toBe(true);
    expect(pushed).toBe(false);
  });

  test("pushes when the user confirms", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Ready\n"),
      ok("origin/feature\n"),
      ok("1\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("feature\n"),
    ];
    const pushCalls: string[][] = [];

    await expect(
      promptToPushCheckedInChanges({
        confirm: () => Promise.resolve(true),
        isInteractive: () => true,
        push: (cmd) => {
          pushCalls.push(cmd);
          return Promise.resolve(ok());
        },
        run: () => Promise.resolve(responses.shift() ?? fail(128)),
      }),
    ).resolves.toBe(true);
    expect(pushCalls).toEqual([["git", "push"]]);
  });

  test("reports push failure", async () => {
    const responses = [
      ok("true\n"),
      ok(""),
      ok("Ready\n"),
      ok("origin/feature\n"),
      ok("1\n"),
      ok("git@github.com:chobbledotcom/tickets.git\n"),
      ok("feature\n"),
    ];

    await expect(
      promptToPushCheckedInChanges({
        confirm: () => Promise.resolve(true),
        isInteractive: () => true,
        push: () => Promise.resolve(fail(1)),
        run: () => Promise.resolve(responses.shift() ?? fail(128)),
      }),
    ).resolves.toBe(false);
  });
});
