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

/**
 * A CI check the report acts on, flattened out of the GraphQL
 * `CheckRun`/`StatusContext` union. Only blocking or in-flight checks become a
 * `Check`; passing/skipped/neutral ones are dropped, so there are just two states.
 */
export interface Check {
  name: string;
  state: "failure" | "pending";
}

/** A PR's CI checks, reduced to the three things a coordinator cares about. */
export interface Checks {
  failing: string[];
  pending: string[];
  /** No rollup at all (no commits, or checks haven't been requested). */
  unknown: boolean;
}

/**
 * A GitHub merge-queue entry. Present (non-null) only when the PR has been
 * added to the repo's merge queue — at that point pushing to the branch
 * disrupts the queue, so the report must surface it loudly.
 */
export interface MergeQueueEntry {
  /** 1-based position in the queue. */
  position: number;
  /** One of GitHub's `MergeQueueEntryState` values. */
  state: "AWAITING_CHECKS" | "LOCKED" | "MERGEABLE" | "QUEUED" | "UNMERGEABLE";
}

/**
 * Everything a {@link PrSignal} reads about a PR, pre-computed once so each
 * signal stays a tiny predicate + sentence. Mirrors `ResolveContext` in
 * `listing-defaults.ts`: the fold builds it, the table entries read it.
 */
export interface PrContext {
  /** The branch this PR merges into (e.g. "main"), named in "behind" facts. */
  baseRef: string;
  behind: boolean;
  blocked: boolean;
  checks: Checks;
  /** Rendered comment phrase (e.g. "Codex (3 current, 1 outdated)"), "" if none. */
  comments: string;
  conflict: boolean;
  /** Count of open review threads on the latest code (the author's move). */
  currentComments: number;
  /** Present when the PR is in GitHub's merge queue — pushing to it disrupts the queue. */
  mergeQueued: MergeQueueEntry | null;
  pr: GraphQlPr;
  reviewers: string[];
  /** GitHub cut off one of this PR's connections, so its data may be incomplete. */
  truncated: boolean;
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
  /** When this fires, the PR lands in this bucket; highest {@link bucketRank} wins. */
  bucket: Bucket;
  /** The plain-language fact sentence (without the leading "branch foo (PR n)"). */
  message: (ctx: PrContext) => string;
}

/** A PR reduced to what a coordinator needs: a bucket and the facts behind it. */
export interface PrSummary {
  author: string;
  branch: string;
  bucket: Bucket;
  facts: string[];
  number: number;
  title: string;
  updatedAt: string;
}

/** `{ hasNextPage }` from a GraphQL connection — true means results were cut off. */
export interface PageInfo {
  hasNextPage: boolean;
}

/** GraphQL response type for a pull request — only the fields we read. */
export interface GraphQlPr {
  author: { login: string } | null;
  baseRefName: string;
  commits: {
    nodes: {
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: { pageInfo: PageInfo; nodes: Record<string, unknown>[] };
        } | null;
      };
    }[];
  };
  headRefName: string;
  isDraft: boolean;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  /** Present only when the PR is in GitHub's merge queue. */
  mergeQueueEntry: MergeQueueEntry | null;
  mergeStateStatus:
    | "BEHIND"
    | "BLOCKED"
    | "CLEAN"
    | "DIRTY"
    | "DRAFT"
    | "HAS_HOOKS"
    | "UNKNOWN"
    | "UNSTABLE";
  number: number;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewRequests: {
    pageInfo: PageInfo;
    nodes: { requestedReviewer: { login: string } | { name: string } | null }[];
  };
  reviewThreads: {
    pageInfo: PageInfo;
    nodes: {
      isResolved: boolean;
      isOutdated: boolean;
      comments: { nodes: { author: { login: string } | null }[] };
    }[];
  };
  title: string;
  updatedAt: string;
}
