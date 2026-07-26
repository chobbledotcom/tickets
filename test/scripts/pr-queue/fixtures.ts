import type { GhRunner } from "#scripts/pr-queue/gh.ts";
import type { GraphQlPr, MergeQueueEntry } from "#scripts/pr-queue/types.ts";

/**
 * Shared `GraphQlPr` fixture builder for the pr-queue summary tests. The default
 * is a clean, ready-to-merge PR (no signals fire); each option toggles one
 * status axis so a test pins a single behaviour. Mirrors `fakeResult` in
 * `mutation-summary.test.ts`.
 */
export type ThreadFixture = {
  author: string | null;
  resolved?: boolean;
  outdated?: boolean;
};
/** `{ absent: true }` ⇒ a review request whose `requestedReviewer` is null. */
export type ReviewerFixture =
  | { login: string }
  | { name: string }
  | { absent: true };
export type PrFixture = {
  draft?: boolean;
  mergeable?: GraphQlPr["mergeable"];
  mergeStateStatus?: GraphQlPr["mergeStateStatus"];
  reviewDecision?: GraphQlPr["reviewDecision"];
  baseRefName?: string;
  /** Present ⇒ the PR is in GitHub's merge queue. */
  mergeQueueEntry?: MergeQueueEntry;
  /** "none" ⇒ no rollup (unknown checks); otherwise the named checks per state. */
  checks?:
    | "none"
    | {
        failing?: string[];
        pending?: string[];
        passing?: string[];
        /** Legacy commit statuses arrive as StatusContext nodes (context + state). */
        statusContexts?: {
          passing?: string[];
          failing?: string[];
          error?: string[];
          pending?: string[];
        };
        /** Raw rollup nodes, passed through verbatim (unrecognised shapes). */
        nodes?: Record<string, unknown>[];
      };
  threads?: ThreadFixture[];
  reviewers?: ReviewerFixture[];
  /** Mark a connection's `pageInfo.hasNextPage` true (GitHub truncated it). */
  truncated?: { threads?: boolean; reviewers?: boolean; checks?: boolean };
};

export const checkRun = (
  name: string,
  status: string,
  conclusion = "",
): Record<string, unknown> => ({ conclusion, name, status });

/** A legacy commit status node — the `context` + `state` shape `classifyCheck` also collapses. */
export const statusContext = (
  name: string,
  state: string,
): Record<string, unknown> => ({ context: name, state });

const buildChecks = (
  checks: NonNullable<PrFixture["checks"]>,
  checksTruncated: boolean,
): GraphQlPr["commits"]["nodes"][number]["commit"]["statusCheckRollup"] => {
  if (checks === "none") return null;
  const passing = (checks.passing ?? []).map((name) =>
    checkRun(name, "COMPLETED", "SUCCESS"),
  );
  const failing = (checks.failing ?? []).map((name) =>
    checkRun(name, "COMPLETED", "FAILURE"),
  );
  const pending = (checks.pending ?? []).map((name) =>
    checkRun(name, "IN_PROGRESS", ""),
  );
  const ctx = checks.statusContexts ?? {};
  const ctxPassing = (ctx.passing ?? []).map((name) =>
    statusContext(name, "SUCCESS"),
  );
  const ctxFailing = (ctx.failing ?? []).map((name) =>
    statusContext(name, "FAILURE"),
  );
  const ctxError = (ctx.error ?? []).map((name) =>
    statusContext(name, "ERROR"),
  );
  const ctxPending = (ctx.pending ?? []).map((name) =>
    statusContext(name, "PENDING"),
  );
  const rawNodes = checks.nodes ?? [];
  const nodes = [
    ...passing,
    ...failing,
    ...pending,
    ...ctxPassing,
    ...ctxFailing,
    ...ctxError,
    ...ctxPending,
    ...rawNodes,
  ];
  const hasFailures = failing.length + ctxFailing.length + ctxError.length > 0;
  const hasPending = pending.length + ctxPending.length > 0;
  return {
    contexts: { nodes, pageInfo: { hasNextPage: checksTruncated } },
    state: hasFailures ? "FAILURE" : hasPending ? "PENDING" : "SUCCESS",
  };
};

/** A stand-in `gh` that answers each call in turn and records what it was asked. */
export const ghSaying = (
  ...replies: Partial<Awaited<ReturnType<GhRunner>>>[]
): { calls: string[][]; run: GhRunner } => {
  const calls: string[][] = [];
  let call = 0;
  const run: GhRunner = (args) => {
    calls.push(args);
    const reply = replies[Math.min(call++, replies.length - 1)] ?? {};
    return Promise.resolve({
      code: 0,
      stderr: "",
      stdout: "",
      timedOut: false,
      ...reply,
    });
  };
  return { calls, run };
};

export const makePr = (opts: PrFixture = {}): GraphQlPr => ({
  author: { login: "stefan-burke" },
  baseRefName: opts.baseRefName ?? "main",
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: buildChecks(
            opts.checks ?? { passing: ["test"] },
            opts.truncated?.checks ?? false,
          ),
        },
      },
    ],
  },
  headRefName: "feature-branch",
  isDraft: opts.draft ?? false,
  mergeable: opts.mergeable ?? "MERGEABLE",
  mergeQueueEntry: opts.mergeQueueEntry ?? null,
  mergeStateStatus: opts.mergeStateStatus ?? "CLEAN",
  number: 42,
  reviewDecision: opts.reviewDecision ?? null,
  reviewRequests: {
    nodes: (opts.reviewers ?? []).map((r) =>
      "absent" in r ? { requestedReviewer: null } : { requestedReviewer: r },
    ),
    pageInfo: { hasNextPage: opts.truncated?.reviewers ?? false },
  },
  reviewThreads: {
    nodes: (opts.threads ?? []).map((t) => ({
      comments: {
        nodes: [{ author: t.author === null ? null : { login: t.author } }],
      },
      isOutdated: t.outdated ?? false,
      isResolved: t.resolved ?? false,
    })),
    pageInfo: { hasNextPage: opts.truncated?.threads ?? false },
  },
  title: "Some PR",
  updatedAt: "2026-07-10T12:00:00Z",
});
