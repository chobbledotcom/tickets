#!/usr/bin/env -S deno run --allow-run=gh

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
 * Usage (via `deno task pr-queue`, which scopes permissions to `--allow-run=gh`):
 *   deno task pr-queue            # grouped, plain-language report
 *   deno task pr-queue -- --json  # structured summaries as JSON
 *   deno task pr-queue -- --repo owner/name   # inspect another repo
 */

import { reduce } from "#fp";
import { PAGE_SIZES, truncationWarnings } from "./pr-queue/pagination.ts";
import { renderReport } from "./pr-queue/render.ts";
import { sanitizeSummary, stripControlChars } from "./pr-queue/sanitize.ts";
import { summarizePr } from "./pr-queue/summary.ts";
import type { GraphQlPr, PrSummary } from "./pr-queue/types.ts";
import { red, yellow } from "./precommit/colors.ts";

/**
 * GraphQL query: everything we need for every open PR in one round trip. Owner
 * and name are passed as `$owner`/`$name` variables (never string-spliced), so
 * a repo name containing a quote can't malform the query. Each connection asks
 * for `pageInfo { hasNextPage }` so {@link truncationWarnings} can flag a page
 * we didn't fully fetch instead of understating the count.
 */
const QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN], first: ${PAGE_SIZES.prs}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage }
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
        mergeQueueEntry { state position }
        reviewRequests(first: ${PAGE_SIZES.reviewers}) {
          pageInfo { hasNextPage }
          nodes {
            requestedReviewer {
              ... on User { login }
              ... on Team { name }
              ... on Bot { login }
            }
          }
        }
        reviewThreads(first: ${PAGE_SIZES.threads}) {
          pageInfo { hasNextPage }
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
                contexts(first: ${PAGE_SIZES.checks}) {
                  pageInfo { hasNextPage }
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

/** Give a hung `gh` (network stall, auth prompt) a hard ceiling rather than blocking forever. */
const GH_TIMEOUT_MS = 60_000;

/**
 * Run `gh` with the given args and return its stdout, exiting with a red
 * error on failure. The one place every `gh` call goes through, so the
 * command/error/exit pattern isn't duplicated between GraphQL and repo lookup.
 * A timeout kills a `gh` that hangs so the script fails loudly instead of
 * blocking on a stuck terminal.
 */
const runGh = async (args: string[], failMessage: string): Promise<string> => {
  const signal = AbortSignal.timeout(GH_TIMEOUT_MS);
  const { code, stdout, stderr } = await new Deno.Command("gh", {
    args,
    signal,
  }).output();
  if (signal.aborted) {
    console.error(
      red(`${failMessage}: gh timed out after ${GH_TIMEOUT_MS / 1000}s`),
    );
    Deno.exit(1);
  }
  if (code !== 0) {
    console.error(red(`${failMessage}:\n${new TextDecoder().decode(stderr)}`));
    Deno.exit(code);
  }
  return new TextDecoder().decode(stdout);
};

/**
 * Run a GraphQL query through `gh` and return parsed `data`, exiting on error.
 * Variables are passed via `-f name=value` (declared as `$owner`/`$name` in the
 * query) so untrusted repo strings never get spliced into the query text.
 */
const runGraphQL = async (
  query: string,
  variables: Record<string, string> = {},
): Promise<unknown> => {
  const varArgs = Object.entries(variables).flatMap(([key, value]) => [
    "-f",
    `${key}=${value}`,
  ]);
  const out = await runGh(
    ["api", "graphql", "-f", `query=${query}`, ...varArgs],
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
    // owner/name are variables; the numeric PR aliases are our own ints, safe to splice.
    const data = (await runGraphQL(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } }`,
      { name, owner },
    )) as {
      repository: Record<
        string,
        Pick<GraphQlPr, "mergeable" | "mergeStateStatus">
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
): Promise<{ prs: GraphQlPr[]; morePrs: boolean }> => {
  const data = await runGraphQL(QUERY, { name, owner });
  // `runGraphQL` already exits on any GraphQL error, so a successful response for
  // a real repo always carries `repository.pullRequests`. Read it directly (no
  // optional chaining or empty default) so a malformed payload throws loudly
  // instead of being presented as an empty "0 open" queue.
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
  await refetchUnknownMergeability(owner, name, prs);
  return { morePrs: pullRequests.pageInfo.hasNextPage, prs };
};

/** Resolve the repo owner/name from `--repo`, else `gh repo view`. */
const resolveRepo = async (
  override?: string,
): Promise<{ owner: string; name: string } | null> => {
  // Distinguish "no --repo" (undefined) from an explicit empty value: `--repo ""`
  // must reach the validation error, not silently fall back to auto-detection.
  if (override !== undefined) {
    const parts = override.split("/");
    const [owner, name] = parts;
    // Exactly two non-empty segments: reject "owner/name/extra" so a stray
    // path can't silently target owner/name.
    if (parts.length !== 2 || !owner || !name) {
      // The raw value is echoed to the terminal, so strip control bytes first.
      console.error(
        red(
          `--repo must be "owner/name", got "${stripControlChars(override)}"`,
        ),
      );
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
      red(
        `Unexpected repo name "${stripControlChars(nameWithOwner)}" (expected "owner/name")`,
      ),
    );
    return null;
  }
  return { name, owner };
};

const printHelp = (): void => {
  console.log(`PR queue report — scans open PRs and prints a plain-language status for each.

Usage: deno task pr-queue [-- --json] [-- --repo owner/name]

Options:
  --json              Print structured summaries as JSON instead of the grouped report.
  --repo owner/name   Inspect a repo other than the current one.
  -h, --help          Show this help.`);
};

/**
 * Fold the CLI args left-to-right into a config. `awaitingRepo` carries the
 * one-token lookahead: the token after "--repo" is its value, whatever it looks
 * like. A trailing "--repo" leaves `awaitingRepo` set, which {@link parseArgs}
 * turns into an error rather than a silent fall-back to auto-detection.
 */
type ArgsAcc = {
  help: boolean;
  json: boolean;
  repo?: string;
  awaitingRepo: boolean;
};
const foldArg = (acc: ArgsAcc, arg: string): ArgsAcc => {
  if (acc.awaitingRepo) return { ...acc, awaitingRepo: false, repo: arg };
  if (arg === "--json") return { ...acc, json: true };
  if (arg === "--repo") return { ...acc, awaitingRepo: true };
  if (arg === "-h" || arg === "--help") return { ...acc, help: true };
  console.error(red(`Unknown argument: ${stripControlChars(arg)}`));
  return Deno.exit(2);
};

/** Parse CLI args into a ({ json, repo }) config, exiting on unknown flags. */
const parseArgs = (
  args: string[],
): { help: boolean; json: boolean; repo?: string | undefined } => {
  const parsed = reduce(foldArg, {
    awaitingRepo: false,
    help: false,
    json: false,
  } as ArgsAcc)(args);
  if (parsed.awaitingRepo) {
    console.error(red("--repo requires a value"));
    Deno.exit(2);
  }
  return { help: parsed.help, json: parsed.json, repo: parsed.repo };
};

const main = async (): Promise<void> => {
  const { help, json, repo: repoOverride } = parseArgs(Deno.args);
  if (help) return printHelp();

  const repo = await resolveRepo(repoOverride);
  if (!repo) Deno.exit(1);
  const { prs, morePrs } = await fetchQueue(repo.owner, repo.name);
  for (const warning of truncationWarnings(prs, morePrs)) {
    console.error(yellow(`⚠ ${warning}`));
  }
  // Strip control characters once, before either output mode — so a crafted PR
  // title can't inject ANSI into the terminal report or into `--json` piped to
  // a terminal (JSON.stringify leaves C1 bytes unescaped).
  const repoLabel = stripControlChars(`${repo.owner}/${repo.name}`);
  const summaries: PrSummary[] = prs
    .map(summarizePr)
    .map(sanitizeSummary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (json) {
    console.log(
      JSON.stringify(
        {
          open: summaries.length,
          pullRequests: summaries,
          repo: repoLabel,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(renderReport(repoLabel, summaries));
};

main();
