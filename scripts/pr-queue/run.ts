/**
 * The PR queue report itself: read the arguments, ask GitHub, and print either
 * the grouped report or the JSON. Returns the exit code rather than ending the
 * process, so the whole thing can be run in a test.
 */

import { red, yellow } from "#scripts/precommit/colors.ts";
import { PR_QUEUE_USAGE, parsePrQueueArgs } from "./args.ts";
import {
  fetchQueue,
  GhFailure,
  type GhRunner,
  resolveRepo,
  runGhCommand,
} from "./gh.ts";
import { PAGE_SIZES, truncationWarnings } from "./pagination.ts";
import { renderReport } from "./render.ts";
import { sanitizeSummary, stripControlChars } from "./sanitize.ts";
import { summarizePr } from "./summary.ts";
import type { PrSummary } from "./types.ts";

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

interface PrQueueOutput {
  log?: (line: string) => void;
  logError?: (line: string) => void;
  run?: GhRunner;
}

/** Run the report, returning the exit code the entry script should use. */
export const runPrQueue = async (
  args: string[],
  {
    log = console.log,
    logError = console.error,
    run = runGhCommand,
  }: PrQueueOutput = {},
): Promise<number> => {
  const { error, help, json, repo: repoOverride } = parsePrQueueArgs(args);
  if (error !== undefined) {
    logError(red(error));
    return 2;
  }
  if (help) {
    log(PR_QUEUE_USAGE);
    return 0;
  }

  try {
    const repo = await resolveRepo(run, repoOverride);
    const { prs, morePrs } = await fetchQueue(
      run,
      QUERY,
      repo.owner,
      repo.name,
    );
    for (const warning of truncationWarnings(prs, morePrs)) {
      logError(yellow(`\u26a0 ${warning}`));
    }
    // Strip control characters once, before either output mode — so a crafted
    // PR title can't inject ANSI into the terminal report or into `--json`
    // piped to a terminal (JSON.stringify leaves C1 bytes unescaped).
    const repoLabel = stripControlChars(`${repo.owner}/${repo.name}`);
    const summaries: PrSummary[] = prs
      .map(summarizePr)
      .map(sanitizeSummary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    log(
      json
        ? JSON.stringify(
            {
              open: summaries.length,
              pullRequests: summaries,
              repo: repoLabel,
            },
            null,
            2,
          )
        : renderReport(repoLabel, summaries),
    );
    return 0;
  } catch (failure) {
    if (!(failure instanceof GhFailure)) throw failure;
    logError(red(failure.message));
    return failure.exitCode;
  }
};
