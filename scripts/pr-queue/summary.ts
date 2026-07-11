/**
 * The pure core of the PR queue report: turn one pull request into a bucket
 * and the plain-language facts behind it.
 *
 * The status checks are a data table ({@link PR_SIGNALS}) folded by
 * {@link summarizePr} — not an if/else ladder — so a new signal is one entry,
 * not a new branch bolted onto a dispatcher. Each signal carries the bucket it
 * forces; the bucket is the highest-priority fired signal (defaulting to
 * READY when none fire). This mirrors `LISTING_DEFAULT_FIELDS` +
 * `resolveListingDefaults`: the invariants live with the signals they guard.
 *
 * This module is pure (no I/O), so it is unit-testable directly — see
 * `test/scripts/pr-queue-summary.test.ts`.
 */

import { filter, mapNotNullish, reduce } from "#fp";
import type {
  Bucket,
  Check,
  Checks,
  GraphQlPr,
  PrContext,
  PrSignal,
  PrSummary,
} from "./types.ts";

/**
 * Bucket resolution priority. A signal that fires for a higher-rank bucket
 * wins: a draft with conflicts is still a DRAFT (draft is the author's call to
 * finish), and a PR with both open comments and failing checks lands in
 * ATTENTION. READY is the floor — no signal carries it; the fold defaults to
 * it when nothing fires.
 */
const BUCKET_RANK: Record<Bucket, number> = {
  ATTENTION: 2,
  DRAFT: 3,
  QUEUED: 4,
  READY: 0,
  WAITING: 1,
};

/** Short, human-readable labels for the bots that review here. Logs are ugly. */
const BOT_NAMES: Record<string, string> = {
  "chatgpt-codex-connector": "Codex",
  coderabbitai: "CodeRabbit",
};
const displayName = (login: string): string => BOT_NAMES[login] ?? login;

/**
 * Turn a status-check rollup node into a failing or still-running Check, or null
 * when it neither blocks nor is in flight. A GitHub GraphQL boundary adapter —
 * `CheckRun` carries `name`+`status`/`conclusion`, `StatusContext` carries
 * `context`+`state`. Only the two states the report acts on (`failure`,
 * `pending`) are surfaced; a passing/skipped/neutral check drops to null so it
 * can't be mistaken for either.
 */
const classifyCheck = (node: Record<string, unknown>): Check | null => {
  if (typeof node.name === "string") {
    const status = String(node.status);
    if (status !== "COMPLETED") return { name: node.name, state: "pending" };
    const conclusion = String(node.conclusion);
    // GitHub only counts SUCCESS / SKIPPED / NEUTRAL as a passing required check;
    // every other conclusion (including a cancelled, stale, or startup-failed run)
    // blocks the merge, so it must read as failing rather than be waved through.
    if (
      [
        "FAILURE",
        "TIMED_OUT",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
        "CANCELLED",
        "STALE",
      ].includes(conclusion)
    ) {
      return { name: node.name, state: "failure" };
    }
    return null; // SUCCESS / SKIPPED / NEUTRAL — non-blocking
  }
  if (typeof node.context === "string") {
    const state = String(node.state);
    if (["FAILURE", "ERROR"].includes(state)) {
      return { name: node.context, state: "failure" };
    }
    if (state === "SUCCESS") return null;
    return { name: node.context, state: "pending" }; // PENDING / EXPECTED
  }
  return null;
};

/** A PR's CI checks, reduced to the failing and still-running check names. */
const summarizeChecks = (pr: GraphQlPr): Checks => {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  if (!rollup) return { failing: [], pending: [], unknown: true };
  const checks = mapNotNullish((n: Record<string, unknown>) =>
    classifyCheck(n),
  )(rollup.contexts.nodes);
  const names = (state: Check["state"]): string[] =>
    filter((c: Check) => c.state === state)(checks).map((c) => c.name);
  return {
    failing: names("failure"),
    pending: names("pending"),
    unknown: false,
  };
};

/**
 * Open review threads, grouped by who first commented and current-vs-stale.
 * A current thread is on the latest code (the author's move); an outdated one
 * is on code that has since moved (the reviewer's move to re-resolve).
 */
type ReviewThread = GraphQlPr["reviewThreads"]["nodes"][number];
/**
 * Label for an unresolved thread whose first comment has no author (a deleted
 * or ghost user). We still count it — an open thread means the PR is not done,
 * so dropping it silently could show a PR as ready when it isn't.
 */
const UNKNOWN_REVIEWER = "an unknown reviewer";
const aggregateUnresolved = (
  pr: GraphQlPr,
): Map<string, { current: number; outdated: number }> =>
  reduce((by, thread: ReviewThread) => {
    if (thread.isResolved) return by;
    // An empty or missing first-comment author both read as an unknown
    // reviewer — an open thread must never vanish for want of a login.
    const author = thread.comments.nodes[0]?.author?.login || UNKNOWN_REVIEWER;
    const entry = by.get(author) ?? { current: 0, outdated: 0 };
    thread.isOutdated ? entry.outdated++ : entry.current++;
    by.set(author, entry);
    return by;
  }, new Map<string, { current: number; outdated: number }>())(
    pr.reviewThreads.nodes,
  );

/**
 * Total current (on-the-latest-code) open threads, across all commenters. Only
 * the current count drives a bucket — an outdated-only thread is the reviewer's
 * move, detected from the comment phrase, not this count.
 */
const countCurrentUnresolved = (pr: GraphQlPr): number =>
  [...aggregateUnresolved(pr).values()].reduce(
    (total, entry) => total + entry.current,
    0,
  );

/** Human-readable phrase, e.g. "Codex (3 current, 1 outdated)". Drops the zero half. */
const commentPhrase = (pr: GraphQlPr): string =>
  aggregateUnresolved(pr)
    .entries()
    .toArray()
    .map(([login, { current, outdated }]) => {
      const tag =
        current > 0 && outdated > 0
          ? `${current} current, ${outdated} outdated`
          : current > 0
            ? `${current} current`
            : `${outdated} outdated`;
      return `${displayName(login)} (${tag})`;
    })
    .join(", ");

/** Reviewers still asked to review, with bot logins cleaned up for display. */
const requestedReviewers = (pr: GraphQlPr): string[] =>
  mapNotNullish(
    (r: { requestedReviewer: { login: string } | { name: string } | null }) => {
      const rev = r.requestedReviewer;
      if (!rev) return null;
      return "login" in rev ? displayName(rev.login) : rev.name;
    },
  )(pr.reviewRequests.nodes);

/** The phrase every comment signal shares — factored out so no duplication. */
const commentMessage = ({ comments }: PrContext): string =>
  `has open comments from ${comments}`;

/**
 * The status signals, in fact-display order — the single source of truth for
 * what each PR reports and which bucket it lands in. A signal fires when its
 * `applies` predicate holds; its `message` becomes one fact line; its `bucket`
 * competes by {@link BUCKET_RANK} for the PR's bucket. Adding a check is one
 * entry here, not a new arm on every dispatcher.
 *
 * The two comment signals are mutually exclusive — current comments are the
 * author's move (ATTENTION); only-outdated comments are the reviewer's move
 * to re-resolve (WAITING) — but both surface the same fact, via
 * {@link commentMessage}. The merge-queue signal has its own QUEUED bucket:
 * once a PR is in GitHub's queue the next move is the queue's, not ours —
 * pushing to the branch would disrupt it, so the fact says so plainly.
 */
const PR_SIGNALS: PrSignal[] = [
  {
    applies: ({ mergeQueued }) => mergeQueued !== null,
    bucket: "QUEUED",
    // mergeQueued is guaranteed non-null here: this signal only reports when its
    // own `applies` has already passed, so access it directly and let any
    // invariant violation fail loudly rather than print "position undefined".
    message: ({ mergeQueued }) =>
      `is in GitHub's merge queue (position ${mergeQueued!.position}, ${mergeQueued!.state.toLowerCase().replace(/_/g, " ")}) — do not push to this branch`,
  },
  {
    applies: ({ pr }) => pr.isDraft,
    bucket: "DRAFT",
    message: () => "is still a draft",
  },
  {
    applies: ({ pr }) => pr.mergeable === "UNKNOWN",
    bucket: "WAITING",
    message: () =>
      "GitHub is still computing mergeability — re-run shortly to confirm whether it can merge",
  },
  {
    // mergeable can resolve while the detailed merge state is still UNKNOWN;
    // that PR isn't ready either, so wait rather than fall through to READY.
    // Guarded on mergeable so it doesn't double up with the signal above.
    applies: ({ pr }) =>
      pr.mergeStateStatus === "UNKNOWN" && pr.mergeable !== "UNKNOWN",
    bucket: "WAITING",
    message: () =>
      "GitHub is still computing the merge state — re-run shortly to confirm whether it can merge",
  },
  {
    applies: ({ conflict }) => conflict,
    bucket: "ATTENTION",
    message: () => "is held up by merge conflicts (needs a rebase)",
  },
  {
    applies: ({ pr }) => pr.reviewDecision === "CHANGES_REQUESTED",
    bucket: "ATTENTION",
    message: () => "has changes requested by reviewers",
  },
  {
    applies: ({ checks }) => checks.failing.length > 0,
    bucket: "ATTENTION",
    message: ({ checks }) =>
      `has failing checks (${checks.failing.join(", ")})`,
  },
  {
    applies: ({ behind }) => behind,
    bucket: "ATTENTION",
    message: ({ baseRef }) =>
      `is behind ${baseRef} and needs ${baseRef} merged in`,
  },
  {
    applies: ({ blocked }) => blocked,
    bucket: "WAITING",
    message: () =>
      "is blocked by branch protection (missing a required review or status check)",
  },
  {
    applies: ({ reviewers }) => reviewers.length > 0,
    bucket: "WAITING",
    message: ({ reviewers }) =>
      `is waiting on a review from ${reviewers.join(", ")}`,
  },
  {
    // A current thread implies a non-empty phrase, so the count alone decides.
    applies: ({ currentComments }) => currentComments > 0,
    bucket: "ATTENTION",
    message: commentMessage,
  },
  {
    // Only-outdated threads: there are open comments (phrase non-empty) but none
    // on the latest code. The phrase check separates this from a PR with none.
    applies: ({ comments, currentComments }) =>
      comments !== "" && currentComments === 0,
    bucket: "WAITING",
    message: commentMessage,
  },
  {
    applies: ({ checks }) => checks.pending.length > 0,
    bucket: "WAITING",
    message: ({ checks }) =>
      `has checks still running (${checks.pending.join(", ")})`,
  },
  {
    // Suppressed while conflicting: a conflicting PR's checks are irrelevant,
    // and the conflict signal already forced ATTENTION.
    applies: ({ checks, conflict }) => checks.unknown && !conflict,
    bucket: "WAITING",
    message: () => "has no CI checks yet",
  },
  {
    // GitHub returned more of this PR's threads, reviewers, or checks than we
    // fetched, so an omitted open comment or failing check could otherwise let
    // it read as READY. Never present truncated data as authoritative — wait.
    applies: ({ truncated }) => truncated,
    bucket: "WAITING",
    message: () =>
      "has more review threads, reviewers, or checks than were fetched — re-run to see the full picture",
  },
];

/** True when GitHub cut off any of this PR's connections at its first page. */
const hasTruncatedConnection = (pr: GraphQlPr): boolean =>
  pr.reviewThreads.pageInfo.hasNextPage ||
  pr.reviewRequests.pageInfo.hasNextPage ||
  (pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.pageInfo
    .hasNextPage ??
    false);

/** Build the pre-computed context every signal reads, from one raw PR. */
const buildContext = (pr: GraphQlPr): PrContext => {
  const comments = commentPhrase(pr);
  return {
    baseRef: pr.baseRefName,
    behind: pr.mergeStateStatus === "BEHIND",
    blocked: pr.mergeStateStatus === "BLOCKED",
    checks: summarizeChecks(pr),
    comments,
    conflict: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
    currentComments: countCurrentUnresolved(pr),
    mergeQueued: pr.mergeQueueEntry,
    pr,
    reviewers: requestedReviewers(pr),
    truncated: hasTruncatedConnection(pr),
  };
};

/** The signals that fire for a PR, in display order. */
const firedSignals = (ctx: PrContext): PrSignal[] =>
  filter((s: PrSignal) => s.applies(ctx))(PR_SIGNALS);

/** The bucket a PR lands in: highest-rank fired signal, or READY when none fire. */
const bucketFor = (ctx: PrContext): Bucket => {
  const fired = firedSignals(ctx);
  if (fired.length === 0) return "READY";
  return reduce(
    (best: Bucket, s: PrSignal) =>
      BUCKET_RANK[s.bucket] > BUCKET_RANK[best] ? s.bucket : best,
    "READY" as Bucket,
  )(fired);
};

/** The fact sentences for a PR; a clean PR gets one "ready to merge" line. */
const factsFor = (ctx: PrContext): string[] => {
  const facts = firedSignals(ctx).map((s) => s.message(ctx));
  return facts.length > 0
    ? facts
    : ["is ready to merge — all checks pass, no open comments"];
};

/**
 * Reduce one pull request to a bucket and the facts behind it. Pure: callers
 * fetch the PR, this computes. Buckets and facts both derive from the one
 * {@link PR_SIGNALS} declaration, so they can never disagree about a PR's state.
 */
export const summarizePr = (pr: GraphQlPr): PrSummary => {
  const ctx = buildContext(pr);
  return {
    // A missing or empty author login both read as "unknown".
    author: pr.author?.login || "unknown",
    branch: pr.headRefName,
    bucket: bucketFor(ctx),
    facts: factsFor(ctx),
    number: pr.number,
    title: pr.title,
    updatedAt: pr.updatedAt,
  };
};
