import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  fetchQueue,
  GhFailure,
  resolveRepo,
  runGhCommand,
} from "#scripts/pr-queue/gh.ts";
import type { GraphQlPr } from "#scripts/pr-queue/types.ts";
import { captureCommands } from "#test-utils/command-capture.ts";
import { withTempDir } from "#test-utils/files.ts";
import { ghSaying, queueReply } from "./fixtures.ts";

/**
 * Runs in a child Deno under the report task's exact permissions. The child
 * inherits a non-empty `LD_LIBRARY_PATH`, which makes Deno refuse to spawn a
 * subprocess while `--allow-run` permits only `gh` — unless the spawn clears
 * the variable, which is what the production runner does. The script exits 0
 * when the real `gh --version` ran; on any other outcome it writes the
 * failure to stderr and exits 1, so the parent can name what broke.
 *
 * The module is imported there by its own resolved URL, because the child
 * cannot reach the repo's import map for aliases.
 */
const spawnScript = (runnerUrl: string): string => `
import { runGhCommand } from "${runnerUrl}";
const result = await runGhCommand(["--version"]);
if (result.code !== 0) {
  console.error("gh --version exited " + result.code + ": " + result.stderr);
  Deno.exit(1);
}
`;
/** The failure a call threw, so its message and exit code can be checked. */
const failureFrom = async (call: Promise<unknown>): Promise<GhFailure> => {
  const error = await call.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(GhFailure);
  return error as GhFailure;
};

const pr = (number: number, mergeable: string): GraphQlPr =>
  ({ mergeable, mergeStateStatus: "UNKNOWN", number }) as GraphQlPr;

const settledReply = (numbers: number[]): string =>
  JSON.stringify({
    data: {
      repository: Object.fromEntries(
        numbers.map((n) => [
          `pr${n}`,
          { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
        ]),
      ),
    },
  });

const noWait = () => Promise.resolve();

describe("running the gh command itself", () => {
  test("runs gh with both streams captured", async () => {
    const captured = captureCommands({
      code: 2,
      signal: null,
      stderr: new TextEncoder().encode("nope"),
      stdout: new TextEncoder().encode("hi"),
      success: false,
    });
    const commandNamespace = Deno as unknown as {
      Command: typeof captured.Command;
    };
    using _command = stub(commandNamespace, "Command", captured.Command);

    expect(await runGhCommand(["pr", "list"])).toEqual({
      code: 2,
      stderr: "nope",
      stdout: "hi",
      success: false,
      timedOut: false,
    });
    expect(captured.commands[0]?.command).toBe("gh");
    expect(captured.commands[0]?.options.args).toEqual(["pr", "list"]);
    expect(captured.commands[0]?.options.env).toEqual({ LD_LIBRARY_PATH: "" });
    expect(captured.commands[0]?.options.stdout).toBe("piped");
    expect(captured.commands[0]?.options.stderr).toBe("piped");
  });

  test("spawns the real gh from a loader-path environment under --allow-run=gh", async () => {
    // Reproduces the NixOS failure the env clear fixes: the child runs with
    // only gh permitted, a non-empty loader path inherited, and the production
    // spawn. Without the clear, Deno refuses the spawn with NotCapable.
    await withTempDir(async (dir) => {
      const childPath = `${dir}/spawn-gh.ts`;
      await Deno.writeTextFile(
        childPath,
        spawnScript(import.meta.resolve("#scripts/pr-queue/gh.ts")),
      );
      const repoRoot = resolve(import.meta.dirname!, "../../..");
      const child = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-check",
          "--config",
          `${repoRoot}/deno.json`,
          "--allow-run=gh",
          childPath,
        ],
        env: {
          // Deno injects the run's coverage dir into a spawned deno even
          // when the env is replaced, and the child would dump a record for
          // the temp script this test deletes before the merge reads it.
          // Point the child at a throwaway dir so the run's coverage data
          // never sees a script whose source is already gone.
          DENO_COVERAGE_DIR: `${dir}/child-coverage`,
          LD_LIBRARY_PATH: "/nowhere-useful",
          PATH: Deno.env.get("PATH") ?? "",
        },
        stderr: "piped",
        stdout: "piped",
      }).output();
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(child.code).toBe(0);
    });
  });
});

describe("working out which repo to report on", () => {
  test("takes owner and name from --repo without asking gh", async () => {
    const { calls, run } = ghSaying();

    expect(await resolveRepo(run, "chobbledotcom/tickets")).toEqual({
      name: "tickets",
      owner: "chobbledotcom",
    });
    expect(calls).toEqual([]);
  });

  test("asks gh when no repo was given", async () => {
    const { calls, run } = ghSaying({
      stdout: '{"nameWithOwner":"chobbledotcom/tickets"}',
    });

    expect(await resolveRepo(run)).toEqual({
      name: "tickets",
      owner: "chobbledotcom",
    });
    expect(calls).toEqual([["repo", "view", "--json", "nameWithOwner"]]);
  });

  test("rejects a --repo with a trailing path", async () => {
    const { run } = ghSaying();

    const failure = await failureFrom(resolveRepo(run, "owner/name/extra"));
    expect(failure.message).toBe(
      '--repo must be "owner/name", got "owner/name/extra"',
    );
    expect(failure.exitCode).toBe(1);
  });

  test("rejects a --repo with an empty half", async () => {
    const { run } = ghSaying();

    expect((await failureFrom(resolveRepo(run, "/name"))).message).toBe(
      '--repo must be "owner/name", got "/name"',
    );
    expect((await failureFrom(resolveRepo(run, "owner/"))).message).toBe(
      '--repo must be "owner/name", got "owner/"',
    );
  });

  test("strips control characters from a repo it echoes back", async () => {
    const { run } = ghSaying();

    expect((await failureFrom(resolveRepo(run, "[31mbad"))).message).toBe(
      '--repo must be "owner/name", got "[31mbad"',
    );
  });

  test("rejects a name gh reported that is not owner/name", async () => {
    const { run } = ghSaying({ stdout: '{"nameWithOwner":"lonely"}' });

    expect((await failureFrom(resolveRepo(run))).message).toBe(
      'Unexpected repo name, expected "owner/name", got "lonely"',
    );
  });

  test("tells you how to name a repo when gh cannot find one", async () => {
    const { run } = ghSaying({ code: 1, stderr: "not a repository" });

    expect((await failureFrom(resolveRepo(run))).message).toBe(
      "Could not detect repo (run inside a gh repo, or pass --repo):\nnot a repository",
    );
  });

  test("names the failure so it can be told apart from a crash", async () => {
    const { run } = ghSaying({ code: 1, stderr: "no" });

    expect((await failureFrom(resolveRepo(run))).name).toBe("GhFailure");
  });

  test("says how long it waited when gh hangs", async () => {
    const { run } = ghSaying({ timedOut: true });

    const failure = await failureFrom(resolveRepo(run));
    expect(failure.message).toBe(
      "Could not detect repo (run inside a gh repo, or pass --repo): gh timed out after 60s",
    );
    expect(failure.exitCode).toBe(1);
  });

  test("passes gh's own exit code on", async () => {
    const { run } = ghSaying({ code: 4, stderr: "not logged in" });

    expect((await failureFrom(resolveRepo(run))).exitCode).toBe(4);
  });
});

describe("fetching the queue", () => {
  test("passes values as named variables, never inside the query", async () => {
    const { calls, run } = ghSaying({ stdout: queueReply([]) });

    await fetchQueue(run, "query {}", "me", 'a"b', noWait);

    expect(calls[0]).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query {}",
      "-f",
      'name=a"b',
      "-f",
      "owner=me",
    ]);
  });

  test("hands back the pull requests and whether a page was left behind", async () => {
    const { run } = ghSaying({
      stdout: queueReply([pr(1, "MERGEABLE")], true),
    });

    // No waiting function passed: nothing here is unsettled, so the real one
    // is never actually waited on.
    const { morePrs, prs } = await fetchQueue(run, "query {}", "me", "repo");

    expect(morePrs).toBe(true);
    expect(prs.map((p) => p.number)).toEqual([1]);
  });

  test("lists every problem GitHub reported", async () => {
    const { run } = ghSaying({
      stdout: '{"errors":[{"message":"one"},{"message":"two"}]}',
    });

    const failure = await failureFrom(
      fetchQueue(run, "query {}", "me", "repo", noWait),
    );
    expect(failure.message).toBe("GraphQL errors:\none\ntwo");
    expect(failure.exitCode).toBe(1);
  });

  test("says which call failed when gh itself fails", async () => {
    const { run } = ghSaying({ code: 3, stderr: "bad token" });

    expect(
      (await failureFrom(fetchQueue(run, "query {}", "me", "repo", noWait)))
        .message,
    ).toBe("gh api graphql failed:\nbad token");
  });

  test("accepts a reply that carries an empty problem list", async () => {
    const { run } = ghSaying({
      stdout: JSON.stringify({
        data: { repository: { pullRequests: { nodes: [], pageInfo: {} } } },
        errors: [],
      }),
    });

    expect(
      (await fetchQueue(run, "query {}", "me", "repo", noWait)).prs,
    ).toEqual([]);
  });

  test("fails loudly when the reply has no pull requests in it", async () => {
    const { run } = ghSaying({ stdout: '{"data":{"repository":{}}}' });

    await expect(
      fetchQueue(run, "query {}", "me", "repo", noWait),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("asking again about pull requests GitHub has not settled", () => {
  /** Fetch a queue, with the given answers to each follow-up question. */
  const fetchWith = (
    prs: GraphQlPr[],
    ...answers: string[]
  ): { calls: string[][]; queued: Promise<{ prs: GraphQlPr[] }> } => {
    const { calls, run } = ghSaying(
      { stdout: queueReply(prs) },
      ...answers.map((stdout) => ({ stdout })),
    );
    return { calls, queued: fetchQueue(run, "query {}", "me", "repo", noWait) };
  };

  test("asks nothing more when every pull request is already settled", async () => {
    const { calls, queued } = fetchWith([pr(1, "MERGEABLE")]);
    await queued;

    expect(calls.length).toBe(1);
  });

  test("fills in the answer for the ones that were unknown", async () => {
    const { calls, queued } = fetchWith(
      [pr(7, "UNKNOWN"), pr(8, "CONFLICTING")],
      settledReply([7]),
    );
    const { prs } = await queued;

    expect(prs[0]?.mergeable).toBe("MERGEABLE");
    expect(prs[0]?.mergeStateStatus).toBe("CLEAN");
    // Only the unknown one is asked about, and only once.
    expect(calls.length).toBe(2);
    expect(calls[1]?.[3]).toContain("pr7: pullRequest(number: 7)");
    expect(calls[1]?.[3]).not.toContain("pr8");
  });

  test("asks about every unsettled pull request in one query", async () => {
    const { calls, queued } = fetchWith(
      [pr(3, "UNKNOWN"), pr(4, "UNKNOWN")],
      '{"data":{"repository":{}}}',
    );
    await queued;

    expect(calls[1]?.[3]).toContain(
      "pr3: pullRequest(number: 3) { mergeable mergeStateStatus }\n" +
        "pr4: pullRequest(number: 4) { mergeable mergeStateStatus }",
    );
  });

  test("gives up after three tries rather than asking forever", async () => {
    const { calls, queued } = fetchWith(
      [pr(1, "UNKNOWN")],
      '{"data":{"repository":{}}}',
    );
    await queued;

    // One call fetches the queue; three more ask about the unknown one.
    expect(calls.length).toBe(4);
  });

  test("stops early once the answer arrives", async () => {
    const { calls, queued } = fetchWith(
      [pr(1, "UNKNOWN")],
      '{"data":{"repository":{}}}',
      settledReply([1]),
    );
    const { prs } = await queued;

    expect(calls.length).toBe(3);
    expect(prs[0]?.mergeable).toBe("MERGEABLE");
  });

  test("waits a short time first, then longer between tries", async () => {
    const waits: number[] = [];
    const { run } = ghSaying(
      { stdout: queueReply([pr(1, "UNKNOWN")]) },
      { stdout: '{"data":{"repository":{}}}' },
    );

    await fetchQueue(run, "query {}", "me", "repo", (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });

    expect(waits).toEqual([500, 1500, 1500]);
  });
});
