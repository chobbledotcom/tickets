#!/usr/bin/env -S deno run --allow-all

/**
 * PR queue report — scans every open pull request on this repo and prints a
 * plain-language status for each (merge conflicts, behind main, whose review
 * comments are still open, whether CI is passing), grouped by who has the next
 * move.
 *
 * This is the thin I/O shell: it fetches PRs via `gh` (one GraphQL query, with
 * a re-poll for GitHub's lazily-computed `mergeable` field), resolves the repo,
 * parses args, and hands the results to the pure {@link ./pr-queue/summary.ts}
 * and {@link ./pr-queue/render.ts} modules. Every fact and bucket decision
 * lives there, testable without a network.
 *
 * Usage:
 *   deno run -A scripts/pr-queue.ts            # grouped, plain-language report
 *   deno run -A scripts/pr-queue.ts --json     # structured summaries as JSON
 *   deno run -A scripts/pr-queue.ts --repo owner/name   # inspect another repo
 */

import { renderReport } from "./pr-queue/render.ts";
import { summarizePr } from "./pr-queue/summary.ts";
import type { GraphQlPr, PrSummary } from "./pr-queue/types.ts";
import { red } from "./precommit/colors.ts";

/** GraphQL query: everything we need for every open PR in one round trip. */
const QUERY = `
query {
  repository(owner: "%OWNER%", name: "%NAME%") {
    pullRequests(states: [OPEN], first: 60, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        isDraft
        headRefName
        baseRefName
        mergeable
        mergeStateStatus
        reviewDecision
        updatedAt
        author { login }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              ... on User { login }
              ... on Team { name }
              ... on Bot { login }
            }
          }
        }
        reviewThreads(first: 100) {
          nodes {
            isResolved
            isOutdated
            comments(first: 1) { nodes { author { login } } }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 50) {
                  nodes {
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Run `gh` with the given args and return its stdout, exiting with a red
 * error on failure. The one place every `gh` call goes through, so the
 * command/error/exit pattern isn't duplicated between GraphQL and repo lookup.
 */
const runGh = async (args: string[], failMessage: string): Promise<string> => {
  const { code, stdout, stderr } = await new Deno.Command("gh", {
    args,
  }).output();
  if (code !== 0) {
    console.error(red(`${failMessage}:\n${new TextDecoder().decode(stderr)}`));
    Deno.exit(code);
  }
  return new TextDecoder().decode(stdout);
};

/** Run a GraphQL query through `gh` and return parsed `data`, exiting on error. */
const runGraphQL = async (query: string): Promise<unknown> => {
  const out = await runGh(
    ["api", "graphql", "-f", `query=${query}`],
    "gh api graphql failed",
  );
  const json = JSON.parse(out) as {
    data?: unknown;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    console.error(
      red(`GraphQL errors:\n${json.errors.map((e) => e.message).join("\n")}`),
    );
    Deno.exit(1);
  }
  return json.data;
};

/**
 * GitHub computes `mergeable` lazily: the first read of a stale PR returns
 * "UNKNOWN", which hides real conflicts. We re-poll just those PRs (one batched
 * query per attempt, a short wait between each) until they resolve or we give
 * up — so a conflict isn't silently missed. Resolved PRs drop out early.
 */
const REPOLL_ATTEMPTS = 3;
const REPOLL_WAIT_MS = 1500;
const refetchUnknownMergeability = async (
  owner: string,
  name: string,
  prs: GraphQlPr[],
): Promise<void> => {
  let pending = prs.filter((pr) => pr.mergeable === "UNKNOWN");
  for (
    let attempt = 0;
    attempt < REPOLL_ATTEMPTS && pending.length > 0;
    attempt++
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, attempt === 0 ? 500 : REPOLL_WAIT_MS),
    );
    const aliases = pending
      .map(
        (pr) =>
          `pr${pr.number}: pullRequest(number: ${pr.number}) { mergeable mergeStateStatus }`,
      )
      .join("\n");
    const data = (await runGraphQL(
      `query { repository(owner: "${owner}", name: "${name}") { ${aliases} } }`,
    )) as {
      repository: Record<
        string,
        { mergeable: string; mergeStateStatus: string }
      >;
    };
    pending = pending.flatMap((pr) => {
      const fresh = data.repository?.[`pr${pr.number}`];
      if (!fresh || fresh.mergeable === "UNKNOWN") return [pr];
      pr.mergeable = fresh.mergeable;
      pr.mergeStateStatus = fresh.mergeStateStatus;
      return [];
    });
  }
};

/** Fetch every open PR plus its review threads and CI checks in one round trip. */
const fetchQueue = async (
  owner: string,
  name: string,
): Promise<GraphQlPr[]> => {
  const data = await runGraphQL(
    QUERY.replace("%OWNER%", owner).replace("%NAME%", name),
  );
  const prs =
    (data as { repository?: { pullRequests?: { nodes: GraphQlPr[] } } })
      .repository?.pullRequests?.nodes ?? [];
  await refetchUnknownMergeability(owner, name, prs);
  return prs;
};

/** Resolve the repo owner/name from `--repo`, else `gh repo view`. */
const resolveRepo = async (
  override?: string,
): Promise<{ owner: string; name: string } | null> => {
  if (override) {
    const [owner, name] = override.split("/");
    if (!owner || !name) {
      console.error(red(`--repo must be "owner/name", got "${override}"`));
      return null;
    }
    return { name, owner };
  }
  const out = await runGh(
    ["repo", "view", "--json", "nameWithOwner"],
    "Could not detect repo (run inside a gh repo, or pass --repo)",
  );
  const { nameWithOwner } = JSON.parse(out) as { nameWithOwner: string };
  const [owner, name] = nameWithOwner.split("/");
  if (!owner || !name) {
    console.error(
      red(`Unexpected repo name "${nameWithOwner}" (expected "owner/name")`),
    );
    return null;
  }
  return { name, owner };
};

const printHelp = (): void => {
  console.log(`PR queue report — scans open PRs and prints a plain-language status for each.

Usage: deno run -A scripts/pr-queue.ts [--json] [--repo owner/name]

Options:
  --json              Print structured summaries as JSON instead of the grouped report.
  --repo owner/name   Inspect a repo other than the current one.
  -h, --help          Show this help.`);
};

/** Parse CLI args into a ({ json, repo }) config, exiting on unknown flags. */
const parseArgs = (
  args: string[],
): { help: boolean; json: boolean; repo?: string | undefined } => {
  let help = false;
  let json = false;
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--repo") repo = args[++i];
    else if (arg === "-h" || arg === "--help") help = true;
    else {
      console.error(red(`Unknown argument: ${arg}`));
      Deno.exit(2);
    }
  }
  return { help, json, repo };
};

const main = async (): Promise<void> => {
  const { help, json, repo: repoOverride } = parseArgs(Deno.args);
  if (help) return printHelp();

  const repo = await resolveRepo(repoOverride);
  if (!repo) Deno.exit(1);
  const summaries: PrSummary[] = (await fetchQueue(repo.owner, repo.name))
    .map(summarizePr)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (json) {
    console.log(
      JSON.stringify(
        {
          open: summaries.length,
          pullRequests: summaries,
          repo: `${repo.owner}/${repo.name}`,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(renderReport(`${repo.owner}/${repo.name}`, summaries));
};

main();
