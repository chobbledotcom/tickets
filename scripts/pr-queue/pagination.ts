/**
 * Page sizes for the PR queue's one GraphQL round trip, and the pure logic that
 * turns "did any connection have more pages?" into plain-language warnings.
 *
 * The report fetches a fixed first page of each connection rather than paging
 * through everything (one round trip keeps the tool fast and simple). That is
 * safe as long as truncation is never silent: {@link truncationWarnings} reads
 * the `pageInfo.hasNextPage` flags the query asks for and names exactly what was
 * cut off, so an operator can see the report is partial instead of trusting an
 * understated count. This module is pure, so it is unit-tested directly.
 */

import { compact, flatMap } from "#fp";
import type { GraphQlPr } from "./types.ts";

/** How many nodes we ask for from each connection in the single query. */
export const PAGE_SIZES = {
  checks: 50,
  prs: 60,
  reviewers: 20,
  threads: 100,
} as const;

/** The rollup contexts connection for a PR's latest commit, or null if absent. */
const latestChecks = (pr: GraphQlPr) =>
  pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts ?? null;

/** The truncation warnings a single PR contributes, in connection order. */
const prWarnings = (pr: GraphQlPr): string[] =>
  compact([
    pr.reviewThreads.pageInfo.hasNextPage
      ? `PR #${pr.number}: more than ${PAGE_SIZES.threads} review threads — some open comments may be missing.`
      : null,
    pr.reviewRequests.pageInfo.hasNextPage
      ? `PR #${pr.number}: more than ${PAGE_SIZES.reviewers} requested reviewers — some may be missing.`
      : null,
    latestChecks(pr)?.pageInfo.hasNextPage
      ? `PR #${pr.number}: more than ${PAGE_SIZES.checks} checks — its CI status may be incomplete.`
      : null,
  ]);

/**
 * One warning line per connection that GitHub says has more pages than we
 * fetched — so a partial report announces what it left out instead of showing
 * an understated count as if it were complete. Empty when nothing was cut off.
 */
export const truncationWarnings = (
  prs: GraphQlPr[],
  morePrs: boolean,
): string[] => [
  ...(morePrs
    ? [
        `More than ${PAGE_SIZES.prs} open PRs — only the ${PAGE_SIZES.prs} most recently updated are shown; older ones are omitted.`,
      ]
    : []),
  ...flatMap(prWarnings)(prs),
];
