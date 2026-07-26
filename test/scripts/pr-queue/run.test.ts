import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PR_QUEUE_USAGE } from "#scripts/pr-queue/args.ts";
import type { GhRunner } from "#scripts/pr-queue/gh.ts";
import { runPrQueue } from "#scripts/pr-queue/run.ts";
import type { GraphQlPr } from "#scripts/pr-queue/types.ts";
import { ghSaying, makePr } from "./fixtures.ts";

/** One open pull request, with the fields this report sorts and prints by. */
const openPr = (over: Partial<GraphQlPr> = {}): GraphQlPr => ({
  ...makePr(),
  ...over,
});

const queueReply = (nodes: GraphQlPr[], hasNextPage = false): string =>
  JSON.stringify({
    data: {
      repository: { pullRequests: { nodes, pageInfo: { hasNextPage } } },
    },
  });

/** Run the report over a stand-in `gh`, collecting both output streams. */
const report = async (
  args: string[],
  run: GhRunner,
): Promise<{ code: number; errors: string[]; logs: string[] }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await runPrQueue(args, {
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
    run,
  });
  return { code, errors, logs };
};

describe("running the PR queue report", () => {
  test("prints the help and stops", async () => {
    const { code, logs } = await report(["--help"], ghSaying().run);

    expect(code).toBe(0);
    expect(logs).toEqual([PR_QUEUE_USAGE]);
  });

  test("complains about an argument it does not know", async () => {
    const { code, errors, logs } = await report(["--nope"], ghSaying().run);

    expect(code).toBe(2);
    expect(logs).toEqual([]);
    expect(errors.join("")).toContain("Unknown argument: --nope");
  });

  test("reports the repo it was told to look at", async () => {
    const { code, logs } = await report(
      ["--repo", "owner/repo"],
      ghSaying({ stdout: queueReply([openPr()]) }).run,
    );

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("owner/repo");
    expect(logs.join("\n")).toContain("Some PR");
  });

  test("prints JSON when asked, with the count and the repo", async () => {
    const { code, logs } = await report(
      ["--json", "--repo", "owner/repo"],
      ghSaying({ stdout: queueReply([openPr()]) }).run,
    );

    expect(code).toBe(0);
    expect(JSON.parse(logs.join(""))).toMatchObject({
      open: 1,
      repo: "owner/repo",
    });
    // Indented, so a person reading it in the terminal can follow it.
    expect(logs.join("")).toContain('\n  "open": 1');
  });

  test("warns when GitHub had more pull requests than it fetched", async () => {
    const { errors } = await report(
      ["--repo", "owner/repo"],
      ghSaying({ stdout: queueReply([openPr()], true) }).run,
    );

    expect(errors.join("\n")).toContain("only the 60 most recently updated");
  });

  test("passes a gh failure's message and exit code out", async () => {
    const { code, errors, logs } = await report(
      ["--repo", "owner/repo"],
      ghSaying({ code: 4, stderr: "not logged in" }).run,
    );

    expect(code).toBe(4);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("not logged in");
  });

  test("lets an unexpected error through rather than hiding it", async () => {
    const exploding: GhRunner = () => Promise.reject(new Error("kaboom"));

    await expect(
      runPrQueue(["--repo", "owner/repo"], { run: exploding }),
    ).rejects.toThrow("kaboom");
  });

  test("shows newest first", async () => {
    const { logs } = await report(
      ["--json", "--repo", "owner/repo"],
      ghSaying({
        stdout: queueReply([
          openPr({ number: 1, updatedAt: "2026-07-01T00:00:00Z" }),
          openPr({ number: 2, updatedAt: "2026-07-09T00:00:00Z" }),
        ]),
      }).run,
    );

    const { pullRequests } = JSON.parse(logs.join("")) as {
      pullRequests: { number: number }[];
    };
    expect(pullRequests.map((p) => p.number)).toEqual([2, 1]);
  });

  test("strips control characters from the repo name it prints", async () => {
    const { logs } = await report(
      ["--json", "--repo", "own[31mer/repo"],
      ghSaying({ stdout: queueReply([]) }).run,
    );

    expect(JSON.parse(logs.join("")).repo).toBe("own[31mer/repo");
  });
});
