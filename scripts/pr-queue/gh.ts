/**
 * Everything the PR queue report asks GitHub for, through the `gh` command.
 *
 * The command itself is a parameter, so the query building, the error wording,
 * and the re-poll for GitHub's lazily-computed merge state can all be checked
 * without a network. A failure comes back as a message and an exit code for the
 * entry script to print, rather than ending the process from in here.
 */

import { captureOutput } from "#scripts/process.ts";
import { delay } from "#shared/now.ts";
import { stripControlChars } from "./sanitize.ts";
import type { GraphQlPr } from "./types.ts";

/** Give a hung `gh` (network stall, auth prompt) a ceiling rather than blocking forever. */
const GH_TIMEOUT_MS = 60_000;

export type GhRunner = (args: string[]) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;

/** A failure the entry script should print and exit with. */
export class GhFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "GhFailure";
    this.exitCode = exitCode;
  }
}

/** Run `gh` through the real command, with a timeout that cannot be waited out. */
export const runGhCommand: GhRunner = async (args) => {
  const signal = AbortSignal.timeout(GH_TIMEOUT_MS);
  const captured = await captureOutput(
    new Deno.Command("gh", {
      args,
      signal,
      stderr: "piped",
      stdout: "piped",
    }),
  );
  return { ...captured, timedOut: signal.aborted };
};

/** Ask `gh` for something, turning any failure into a {@link GhFailure}. */
const askGh = async (
  run: GhRunner,
  args: string[],
  failMessage: string,
): Promise<string> => {
  const { code, stdout, stderr, timedOut } = await run(args);
  if (timedOut) {
    throw new GhFailure(
      `${failMessage}: gh timed out after ${GH_TIMEOUT_MS / 1000}s`,
      1,
    );
  }
  if (code !== 0) throw new GhFailure(`${failMessage}:\n${stderr}`, code);
  return stdout;
};

/**
 * Run a GraphQL query. Values go in as named variables, never spliced into the
 * query text, so a repo name holding a quote cannot malform it.
 */
const askGraphQL = async (
  run: GhRunner,
  query: string,
  variables: Record<string, string> = {},
): Promise<unknown> => {
  const varArgs = Object.entries(variables).flatMap(([key, value]) => [
    "-f",
    `${key}=${value}`,
  ]);
  const out = await askGh(
    run,
    ["api", "graphql", "-f", `query=${query}`, ...varArgs],
    "gh api graphql failed",
  );
  const json = JSON.parse(out) as {
    data?: unknown;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new GhFailure(
      `GraphQL errors:\n${json.errors.map((e) => e.message).join("\n")}`,
      1,
    );
  }
  return json.data;
};

/** Which repo the report is about, worked out from `--repo` or from `gh`. */
export const resolveRepo = async (
  run: GhRunner,
  override?: string,
): Promise<{ owner: string; name: string }> => {
  // An explicit empty value (`--repo ""`) must reach the error below, not fall
  // back to asking gh, so this checks for the flag being absent entirely.
  if (override !== undefined) return splitRepo(override, "--repo must be");
  const out = await askGh(
    run,
    ["repo", "view", "--json", "nameWithOwner"],
    "Could not detect repo (run inside a gh repo, or pass --repo)",
  );
  const { nameWithOwner } = JSON.parse(out) as { nameWithOwner: string };
  return splitRepo(nameWithOwner, "Unexpected repo name, expected");
};

/** Exactly two non-empty parts, so "owner/name/extra" cannot slip through. */
const splitRepo = (
  value: string,
  problem: string,
): { owner: string; name: string } => {
  const parts = value.split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) {
    // The value is echoed to the terminal, so strip control bytes first.
    throw new GhFailure(
      `${problem} "owner/name", got "${stripControlChars(value)}"`,
      1,
    );
  }
  return { name, owner };
};

/**
 * GitHub works out `mergeable` only when asked: the first read of a stale PR
 * says "UNKNOWN", which hides a real conflict. Ask again for just those PRs —
 * one batched query per try, a short wait between — until they settle or the
 * tries run out. PRs that settle drop out early.
 */
const REPOLL_ATTEMPTS = 3;
const REPOLL_WAIT_MS = 1500;
const FIRST_REPOLL_WAIT_MS = 500;

const refetchUnknownMergeability = async (
  run: GhRunner,
  owner: string,
  name: string,
  prs: GraphQlPr[],
  wait: (ms: number) => Promise<void> = delay,
): Promise<void> => {
  let pending = prs.filter((pr) => pr.mergeable === "UNKNOWN");
  for (
    let attempt = 0;
    attempt < REPOLL_ATTEMPTS && pending.length > 0;
    attempt++
  ) {
    await wait(attempt === 0 ? FIRST_REPOLL_WAIT_MS : REPOLL_WAIT_MS);
    const aliases = pending
      .map(
        (pr) =>
          `pr${pr.number}: pullRequest(number: ${pr.number}) { mergeable mergeStateStatus }`,
      )
      .join("\n");
    // owner/name are variables; the numeric PR aliases are our own ints, safe to splice.
    const data = (await askGraphQL(
      run,
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } }`,
      { name, owner },
    )) as {
      repository: Record<
        string,
        Pick<GraphQlPr, "mergeable" | "mergeStateStatus">
      >;
    };
    pending = pending.flatMap((pr) => {
      const fresh = data.repository[`pr${pr.number}`];
      if (!fresh || fresh.mergeable === "UNKNOWN") return [pr];
      pr.mergeable = fresh.mergeable;
      pr.mergeStateStatus = fresh.mergeStateStatus;
      return [];
    });
  }
};

/** Fetch every open PR plus its review threads and CI checks. */
export const fetchQueue = async (
  run: GhRunner,
  query: string,
  owner: string,
  name: string,
  wait?: (ms: number) => Promise<void>,
): Promise<{ prs: GraphQlPr[]; morePrs: boolean }> => {
  const data = await askGraphQL(run, query, { name, owner });
  // Any GraphQL error has already thrown, so a good response for a real repo
  // always carries repository.pullRequests. Read it straight, with no optional
  // chaining or empty default, so a malformed payload fails loudly instead of
  // being shown as an empty "0 open" queue.
  const { pullRequests } = (
    data as {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: boolean };
          nodes: GraphQlPr[];
        };
      };
    }
  ).repository;
  const prs = pullRequests.nodes;
  await refetchUnknownMergeability(run, owner, name, prs, wait);
  return { morePrs: pullRequests.pageInfo.hasNextPage, prs };
};
