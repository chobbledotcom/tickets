import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  askGh,
  askGraphQL,
  fetchQueue,
  GH_TIMEOUT_MS,
  GhFailure,
  type GhRunner,
  refetchUnknownMergeability,
  resolveRepo,
} from "#scripts/pr-queue/gh.ts";
import type { GraphQlPr } from "#scripts/pr-queue/types.ts";

/** A stand-in `gh` that answers each call in turn and records what it was asked. */
const ghSaying = (
  ...replies: Array<Partial<Awaited<ReturnType<GhRunner>>>>
): { calls: string[][]; run: GhRunner } => {
  const calls: string[][] = [];
  let call = 0;
  const run: GhRunner = (args) => {
    calls.push(args);
    const reply = replies[Math.min(call++, replies.length - 1)] ?? {};
    return Promise.resolve({
      code: 0,
      stderr: "",
      stdout: "",
      timedOut: false,
      ...reply,
    });
  };
  return { calls, run };
};

/** The failure a call threw, so its message and exit code can be checked. */
const failureFrom = async (call: Promise<unknown>): Promise<GhFailure> => {
  const error = await call.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(GhFailure);
  return error as GhFailure;
};

const pr = (number: number, mergeable: string): GraphQlPr =>
  ({ mergeable, mergeStateStatus: "UNKNOWN", number }) as GraphQlPr;

describe("asking gh for something", () => {
  test("hands back what gh printed", async () => {
    const { calls, run } = ghSaying({ stdout: "answer" });

    expect(await askGh(run, ["repo", "view"], "could not look")).toBe("answer");
    expect(calls).toEqual([["repo", "view"]]);
  });

  test("says how long it waited when gh hangs", async () => {
    const { run } = ghSaying({ timedOut: true });

    const failure = await failureFrom(askGh(run, ["repo"], "could not look"));
    expect(failure.message).toBe(
      `could not look: gh timed out after ${GH_TIMEOUT_MS / 1000}s`,
    );
    expect(failure.exitCode).toBe(1);
  });

  test("passes gh's own complaint and exit code on", async () => {
    const { run } = ghSaying({ code: 4, stderr: "not logged in" });

    const failure = await failureFrom(askGh(run, ["repo"], "could not look"));
    expect(failure.message).toBe("could not look:\nnot logged in");
    expect(failure.exitCode).toBe(4);
  });
});

describe("running a GraphQL query", () => {
  test("passes values as named variables, never inside the query", async () => {
    const { calls, run } = ghSaying({ stdout: '{"data":{"ok":true}}' });

    expect(
      await askGraphQL(run, "query {}", { name: 'a"b', owner: "me" }),
    ).toEqual({ ok: true });
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

  test("sends no variables when there are none", async () => {
    const { calls, run } = ghSaying({ stdout: '{"data":null}' });

    await askGraphQL(run, "query {}");
    expect(calls[0]).toEqual(["api", "graphql", "-f", "query=query {}"]);
  });

  test("lists every problem GitHub reported", async () => {
    const { run } = ghSaying({
      stdout: '{"errors":[{"message":"one"},{"message":"two"}]}',
    });

    const failure = await failureFrom(askGraphQL(run, "query {}"));
    expect(failure.message).toBe("GraphQL errors:\none\ntwo");
    expect(failure.exitCode).toBe(1);
  });

  test("accepts a reply that carries an empty problem list", async () => {
    const { run } = ghSaying({ stdout: '{"data":{"ok":1},"errors":[]}' });

    expect(await askGraphQL(run, "query {}")).toEqual({ ok: 1 });
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

    expect(
      (await failureFrom(resolveRepo(run, "owner/name/extra"))).message,
    ).toBe('--repo must be "owner/name", got "owner/name/extra"');
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
});

describe("asking again about pull requests GitHub has not settled", () => {
  const settled = (numbers: number[]): string =>
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

  test("asks nothing when every pull request is already settled", async () => {
    const { calls, run } = ghSaying();

    await refetchUnknownMergeability(
      run,
      "me",
      "repo",
      [pr(1, "MERGEABLE")],
      noWait,
    );
    expect(calls).toEqual([]);
  });

  test("fills in the answer for the ones that were unknown", async () => {
    const { calls, run } = ghSaying({ stdout: settled([7]) });
    const prs = [pr(7, "UNKNOWN"), pr(8, "CONFLICTING")];

    await refetchUnknownMergeability(run, "me", "repo", prs, noWait);

    expect(prs[0]?.mergeable).toBe("MERGEABLE");
    expect(prs[0]?.mergeStateStatus).toBe("CLEAN");
    // Only the unknown one is asked about, and only once.
    expect(calls.length).toBe(1);
    expect(calls[0]?.[3]).toContain("pr7: pullRequest(number: 7)");
    expect(calls[0]?.[3]).not.toContain("pr8");
  });

  test("waits a short time first, then longer between tries", async () => {
    const waits: number[] = [];
    const { run } = ghSaying({ stdout: '{"data":{"repository":{}}}' });

    await refetchUnknownMergeability(
      run,
      "me",
      "repo",
      [pr(1, "UNKNOWN")],
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    );

    expect(waits).toEqual([500, 1500, 1500]);
  });

  test("gives up after three tries rather than asking forever", async () => {
    const { calls, run } = ghSaying({ stdout: '{"data":{"repository":{}}}' });

    await refetchUnknownMergeability(
      run,
      "me",
      "repo",
      [pr(1, "UNKNOWN")],
      noWait,
    );

    expect(calls.length).toBe(3);
  });

  test("stops early once the answer arrives", async () => {
    const { calls, run } = ghSaying(
      { stdout: '{"data":{"repository":{}}}' },
      { stdout: settled([1]) },
    );
    const prs = [pr(1, "UNKNOWN")];

    await refetchUnknownMergeability(run, "me", "repo", prs, noWait);

    expect(calls.length).toBe(2);
    expect(prs[0]?.mergeable).toBe("MERGEABLE");
  });
});

describe("fetching the whole queue", () => {
  const queueReply = (hasNextPage: boolean, nodes: GraphQlPr[]): string =>
    JSON.stringify({
      data: {
        repository: { pullRequests: { nodes, pageInfo: { hasNextPage } } },
      },
    });

  test("hands back the pull requests and whether a page was left behind", async () => {
    const { calls, run } = ghSaying({
      stdout: queueReply(true, [pr(1, "MERGEABLE")]),
    });

    const { morePrs, prs } = await fetchQueue(run, "query {}", "me", "repo");

    expect(morePrs).toBe(true);
    expect(prs.map((p) => p.number)).toEqual([1]);
    expect(calls[0]).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query {}",
      "-f",
      "name=repo",
      "-f",
      "owner=me",
    ]);
  });

  test("fails loudly when the reply has no pull requests in it", async () => {
    const { run } = ghSaying({ stdout: '{"data":{"repository":{}}}' });

    await expect(
      fetchQueue(run, "query {}", "me", "repo"),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
