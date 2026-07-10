/**
 * Shared types for the PR queue report.
 *
 * The GraphQL response shape ({@link GraphQlPr}) lives here alongside the
 * pure summary types ({@link PrSummary}, {@link PrContext}, {@link PrSignal})
 * that {@link ./summary.ts} and {@link ./render.ts} both read. Keeping the
 * shapes in one place is what lets the summary fold and the renderer stay
 * independent of each other and of the I/O shell.
 */

/** The "who has the next move" bucket a PR lands in. */
export type Bucket = "QUEUED" | "DRAFT" | "ATTENTION" | "WAITING" | "READY";

/** A CI check, flattened out of the GraphQL `CheckRun`/`StatusContext` union. */
export interface Check {
  name: string;
  state: "success" | "failure" | "pending" | "skipped";
}

/** A PR's CI checks, reduced to the three things a coordinator cares about. */
export interface Checks {
  failing: string[];
  pending: string[];
  /** No rollup at all (no commits, or checks haven't been requested). */
  unknown: boolean;
}

/** Counts of open review threads, split by whether they're on the latest code. */
export interface UnresolvedComments {
  current: number;
  outdated: number;
}

/**
 * A GitHub merge-queue entry. Present (non-null) only when the PR has been
 * added to the repo's merge queue — at that point pushing to the branch
 * disrupts the queue, so the report must surface it loudly.
 */
export interface MergeQueueEntry {
  /** `AWAITING_CHECKS`, `QUEUED`, `MERGEABLE`, or `UNMERGEABLE`. */
  state: string;
  /** 1-based position in the queue. */
  position: number;
}

/**
 * Everything a {@link PrSignal} reads about a PR, pre-computed once so each
 * signal stays a tiny predicate + sentence. Mirrors `ResolveContext` in
 * `listing-defaults.ts`: the fold builds it, the table entries read it.
 */
export interface PrContext {
  pr: GraphQlPr;
  checks: Checks;
  /** Rendered comment phrase (e.g. "Codex (3 current, 1 outdated)"), "" if none. */
  comments: string;
  reviewers: string[];
  unresolved: UnresolvedComments;
  conflict: boolean;
  behind: boolean;
  blocked: boolean;
  /** Present when the PR is in GitHub's merge queue — pushing to it disrupts the queue. */
  mergeQueued: MergeQueueEntry | null;
}

/**
 * One status signal: a predicate, the sentence it adds, and the bucket it
 * forces when it fires. {@link ./summary.ts} folds `PR_SIGNALS` — no if/else
 * ladder — so adding a new signal is one entry, not a new branch in a chain.
 * Mirrors `LISTING_DEFAULT_FIELDS` + `resolveListingDefaults`.
 */
export interface PrSignal {
  /** Fires for this PR? Reads the pre-computed context, never the raw PR. */
  applies: (ctx: PrContext) => boolean;
  /** The plain-language fact sentence (without the leading "branch foo (PR n)"). */
  message: (ctx: PrContext) => string;
  /** When this fires, the PR lands in this bucket; highest {@link bucketRank} wins. */
  bucket: Bucket;
}

/** A PR reduced to what a coordinator needs: a bucket and the facts behind it. */
export interface PrSummary {
  number: number;
  title: string;
  branch: string;
  author: string;
  updatedAt: string;
  bucket: Bucket;
  facts: string[];
}

/** GraphQL response type for a pull request — only the fields we read. */
export interface GraphQlPr {
  number: number;
  title: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  updatedAt: string;
  author: { login: string } | null;
  /** Present only when the PR is in GitHub's merge queue. */
  mergeQueueEntry: MergeQueueEntry | null;
  reviewRequests: {
    nodes: { requestedReviewer: { login: string } | { name: string } | null }[];
  };
  reviewThreads: {
    nodes: {
      isResolved: boolean;
      isOutdated: boolean;
      comments: { nodes: { author: { login: string } | null }[] };
    }[];
  };
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: { nodes: Record<string, unknown>[] };
        } | null;
      };
    }[];
  };
}
