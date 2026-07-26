#!/usr/bin/env -S deno run --allow-run=gh

/**
 * PR queue report — scans every open pull request on this repo and prints a
 * plain-language status for each (merge conflicts, behind main, whose review
 * comments are still open, whether CI is passing), grouped by who has the next
 * move.
 *
 * This is the thin I/O shell: it reads the arguments, asks GitHub through
 * {@link ./pr-queue/gh.ts}, and hands the results to the pure
 * {@link ./pr-queue/summary.ts} and {@link ./pr-queue/render.ts} modules. Every
 * fact and bucket decision lives there, testable without a network.
 *
 * Usage (via `deno task pr-queue`, which scopes permissions to `--allow-run=gh`):
 *   deno task pr-queue            # grouped, plain-language report
 *   deno task pr-queue -- --json  # structured summaries as JSON
 *   deno task pr-queue -- --repo owner/name   # inspect another repo
 */

import { PR_QUEUE_USAGE, parsePrQueueArgs } from "./pr-queue/args.ts";
import {
  fetchQueue,
  GhFailure,
  resolveRepo,
  runGhCommand,
} from "./pr-queue/gh.ts";
import { PAGE_SIZES, truncationWarnings } from "./pr-queue/pagination.ts";
import { renderReport } from "./pr-queue/render.ts";
import { sanitizeSummary, stripControlChars } from "./pr-queue/sanitize.ts";
import { summarizePr } from "./pr-queue/summary.ts";
import type { PrSummary } from "./pr-queue/types.ts";
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

const main = async (): Promise<void> => {
  const { error, help, json, repo: repoOverride } = parsePrQueueArgs(Deno.args);
  if (error !== undefined) {
    console.error(red(error));
    Deno.exit(2);
  }
  if (help) return console.log(PR_QUEUE_USAGE);

  const repo = await resolveRepo(runGhCommand, repoOverride);
  const { prs, morePrs } = await fetchQueue(
    runGhCommand,
    QUERY,
    repo.owner,
    repo.name,
  );
  for (const warning of truncationWarnings(prs, morePrs)) {
    console.error(yellow(`\u26a0 ${warning}`));
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

await main().catch((error: unknown) => {
  if (!(error instanceof GhFailure)) throw error;
  console.error(red(error.message));
  Deno.exit(error.exitCode);
});
