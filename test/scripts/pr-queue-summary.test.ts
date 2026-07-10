import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { summarizePr } from "../../scripts/pr-queue/summary.ts";
import type {
  GraphQlPr,
  MergeQueueEntry,
} from "../../scripts/pr-queue/types.ts";

/**
 * Build a `GraphQlPr` fixture from high-level options. The default is a clean,
 * ready-to-merge PR (no signals fire); each option toggles one status axis so a
 * test pins a single behaviour. Mirrors `fakeResult` in
 * `mutation-summary.test.ts`.
 */
type ThreadFixture = {
  author: string | null;
  resolved?: boolean;
  outdated?: boolean;
};
/** `{ absent: true }` ⇒ a review request whose `requestedReviewer` is null. */
type ReviewerFixture = { login: string } | { name: string } | { absent: true };
type PrFixture = {
  draft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  /** Present ⇒ the PR is in GitHub's merge queue. */
  mergeQueueEntry?: MergeQueueEntry;
  /** "none" ⇒ no rollup (unknown checks); otherwise the named checks per state. */
  checks?:
    | "none"
    | {
        failing?: string[];
        pending?: string[];
        passing?: string[];
        /** Completed-but-non-fatal conclusions (CANCELLED/NEUTRAL) → skipped. */
        skipped?: string[];
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
};

const checkRun = (
  name: string,
  status: string,
  conclusion = "",
): Record<string, unknown> => ({ conclusion, name, status });

/** A legacy commit status node — the `context` + `state` shape `classifyCheck` also collapses. */
const statusContext = (
  name: string,
  state: string,
): Record<string, unknown> => ({ context: name, state });

const buildChecks = (
  checks: NonNullable<PrFixture["checks"]>,
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
  const skipped = (checks.skipped ?? []).map((name) =>
    checkRun(name, "COMPLETED", "CANCELLED"),
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
    ...skipped,
    ...ctxPassing,
    ...ctxFailing,
    ...ctxError,
    ...ctxPending,
    ...rawNodes,
  ];
  const hasFailures = failing.length + ctxFailing.length + ctxError.length > 0;
  const hasPending = pending.length + ctxPending.length > 0;
  return {
    contexts: { nodes },
    state: hasFailures ? "FAILURE" : hasPending ? "PENDING" : "SUCCESS",
  };
};

const makePr = (opts: PrFixture = {}): GraphQlPr => ({
  author: { login: "stefan-burke" },
  baseRefName: "main",
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: buildChecks(opts.checks ?? { passing: ["test"] }),
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
  },
  reviewThreads: {
    nodes: (opts.threads ?? []).map((t) => ({
      comments: {
        nodes: [{ author: t.author === null ? null : { login: t.author } }],
      },
      isOutdated: t.outdated ?? false,
      isResolved: t.resolved ?? false,
    })),
  },
  title: "Some PR",
  updatedAt: "2026-07-10T12:00:00Z",
});

describe("summarizePr", () => {
  describe("buckets and facts", () => {
    const cases: Array<{
      name: string;
      opts: PrFixture;
      bucket: string;
      factContains: string;
    }> = [
      {
        bucket: "READY",
        factContains: "is ready to merge",
        name: "clean PR is READY and reads ready to merge",
        opts: {},
      },
      {
        bucket: "DRAFT",
        factContains: "is still a draft",
        name: "draft lands in DRAFT",
        opts: { draft: true },
      },
      {
        bucket: "ATTENTION",
        factContains: "merge conflicts",
        name: "conflicting PR needs attention and a rebase",
        opts: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
      },
      {
        bucket: "ATTENTION",
        factContains: "changes requested",
        name: "changes requested needs attention",
        opts: { reviewDecision: "CHANGES_REQUESTED" },
      },
      {
        bucket: "ATTENTION",
        factContains: "failing checks (test, lint)",
        name: "failing checks need attention and name them",
        opts: { checks: { failing: ["test", "lint"] } },
      },
      {
        bucket: "ATTENTION",
        factContains: "behind main",
        name: "behind main needs attention",
        opts: { mergeStateStatus: "BEHIND" },
      },
      {
        bucket: "WAITING",
        factContains: "blocked by branch protection",
        name: "blocked by branch protection waits",
        opts: { mergeStateStatus: "BLOCKED" },
      },
      {
        bucket: "WAITING",
        factContains: "checks still running (test)",
        name: "pending checks wait and name them",
        opts: { checks: { passing: ["build"], pending: ["test"] } },
      },
      {
        bucket: "WAITING",
        factContains: "waiting on a review from alice, infra-team",
        name: "pending review request waits and names the reviewer",
        opts: { reviewers: [{ login: "alice" }, { name: "infra-team" }] },
      },
      {
        bucket: "WAITING",
        factContains: "still computing mergeability",
        name: "mergeable UNKNOWN waits for GitHub to compute",
        opts: { mergeable: "UNKNOWN" },
      },
      {
        bucket: "WAITING",
        factContains: "no CI checks yet",
        name: "no CI rollup waits and flags no checks",
        opts: { checks: "none" },
      },
      {
        bucket: "ATTENTION",
        factContains: "failing checks (deploy)",
        name: "a failing legacy commit status needs attention and names it",
        opts: {
          checks: {
            passing: ["build"],
            statusContexts: { failing: ["deploy"] },
          },
        },
      },
      {
        bucket: "ATTENTION",
        factContains: "failing checks (deploy)",
        name: "an errored legacy commit status is a failure",
        opts: {
          checks: { passing: ["build"], statusContexts: { error: ["deploy"] } },
        },
      },
      {
        bucket: "WAITING",
        factContains: "checks still running (ci)",
        name: "a pending legacy commit status waits and names it",
        opts: {
          checks: { passing: ["build"], statusContexts: { pending: ["ci"] } },
        },
      },
      {
        bucket: "READY",
        factContains: "is ready to merge",
        name: "a passing legacy commit status is neither failing nor pending",
        opts: {
          checks: {
            passing: ["build"],
            statusContexts: { passing: ["deploy"] },
          },
        },
      },
      {
        bucket: "READY",
        factContains: "is ready to merge",
        name: "a cancelled check run is neither failing nor pending",
        opts: { checks: { passing: ["build"], skipped: ["lint"] } },
      },
      {
        bucket: "READY",
        factContains: "is ready to merge",
        name: "an unrecognised rollup node shape is dropped",
        opts: {
          checks: { nodes: [{ unrecognized: true }], passing: ["build"] },
        },
      },
      {
        bucket: "QUEUED",
        factContains: "do not push to this branch",
        name: "a merge-queued PR lands in its own bucket and warns against pushing",
        opts: {
          mergeQueueEntry: { position: 1, state: "AWAITING_CHECKS" },
        },
      },
    ];

    for (const { name, opts, bucket, factContains } of cases) {
      test(name, () => {
        const s = summarizePr(makePr(opts));
        expect(s.bucket).toBe(bucket);
        expect(s.facts.some((f) => f.includes(factContains))).toBe(true);
      });
    }
  });

  test("clean PR emits exactly one ready fact and no others", () => {
    const s = summarizePr(makePr());
    expect(s.facts).toHaveLength(1);
    expect(s.facts[0]).toBe(
      "is ready to merge — all checks pass, no open comments",
    );
  });

  test("failing checks fact lists every failing check name", () => {
    const s = summarizePr(makePr({ checks: { failing: ["a", "b", "c"] } }));
    expect(s.facts.some((f) => f === "has failing checks (a, b, c)")).toBe(
      true,
    );
  });

  describe("review comments", () => {
    test("current open comments need attention and phrase per commenter with tallies", () => {
      const s = summarizePr(
        makePr({
          threads: [
            { author: "chatgpt-codex-connector" },
            { author: "chatgpt-codex-connector", outdated: true },
            { author: "coderabbitai" },
          ],
        }),
      );
      expect(s.bucket).toBe("ATTENTION");
      expect(s.facts).toContain(
        "has open comments from Codex (1 current, 1 outdated), CodeRabbit (1 current)",
      );
    });

    test("only-outdated comments wait (reviewer's move to re-resolve)", () => {
      const s = summarizePr(
        makePr({
          threads: [{ author: "chatgpt-codex-connector", outdated: true }],
        }),
      );
      expect(s.bucket).toBe("WAITING");
      expect(s.facts).toContain("has open comments from Codex (1 outdated)");
    });

    test("resolved threads never count toward the comment phrase", () => {
      const s = summarizePr(
        makePr({
          threads: [{ author: "chatgpt-codex-connector", resolved: true }],
        }),
      );
      expect(s.bucket).toBe("READY");
      expect(s.facts.some((f) => f.includes("has open comments from"))).toBe(
        false,
      );
    });

    test("a thread whose first comment has no author is ignored", () => {
      // The authorless thread must be dropped (not counted as a phantom
      // commenter), leaving only the one real current comment.
      const s = summarizePr(
        makePr({
          threads: [{ author: null }, { author: "alice" }],
        }),
      );
      expect(s.bucket).toBe("ATTENTION");
      expect(s.facts).toContain("has open comments from alice (1 current)");
      // No empty-login phantom leaks into the phrase.
      expect(s.facts.some((f) => f.includes("()"))).toBe(false);
    });
  });

  describe("review requests", () => {
    test("a review request with no requested reviewer is ignored", () => {
      // The null `requestedReviewer` must be dropped, leaving the named
      // reviewers phrased in their original order.
      const s = summarizePr(
        makePr({
          reviewers: [
            { login: "alice" },
            { absent: true },
            { name: "infra-team" },
          ],
        }),
      );
      expect(s.bucket).toBe("WAITING");
      expect(s.facts).toContain(
        "is waiting on a review from alice, infra-team",
      );
    });
  });

  describe("bucket precedence and fact order", () => {
    test("draft outranks conflict — a draft with conflicts still lands in DRAFT", () => {
      const s = summarizePr(
        makePr({
          draft: true,
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        }),
      );
      expect(s.bucket).toBe("DRAFT");
      // Both facts still surface, in signal order: draft first, then conflict.
      expect(s.facts).toEqual([
        "is still a draft",
        "is held up by merge conflicts (needs a rebase)",
      ]);
    });

    test("attention outranks waiting when both apply (behind + pending checks)", () => {
      const s = summarizePr(
        makePr({
          checks: { passing: ["build"], pending: ["test"] },
          mergeStateStatus: "BEHIND",
        }),
      );
      expect(s.bucket).toBe("ATTENTION");
      // Behind (attention) is listed before pending checks (waiting) in signal order.
      const behindIdx = s.facts.findIndex((f) => f.includes("behind main"));
      const pendingIdx = s.facts.findIndex((f) =>
        f.includes("checks still running"),
      );
      expect(behindIdx).toBeLessThan(pendingIdx);
      expect(pendingIdx).toBeGreaterThan(-1);
    });

    test("checks.unknown is suppressed while conflicting (a conflicting PR's checks are moot)", () => {
      const s = summarizePr(
        makePr({
          checks: "none",
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        }),
      );
      expect(s.bucket).toBe("ATTENTION");
      expect(s.facts.some((f) => f.includes("merge conflicts"))).toBe(true);
      expect(s.facts.some((f) => f.includes("no CI checks yet"))).toBe(false);
    });

    test("merge queue outranks attention — a queued PR with open comments stays QUEUED", () => {
      const s = summarizePr(
        makePr({
          mergeQueueEntry: { position: 1, state: "AWAITING_CHECKS" },
          threads: [{ author: "chatgpt-codex-connector" }],
        }),
      );
      expect(s.bucket).toBe("QUEUED");
      expect(
        s.facts.some((f) => f.includes("do not push to this branch")),
      ).toBe(true);
      expect(s.facts.some((f) => f.includes("open comments"))).toBe(true);
    });

    test("merge-queue fact shows position and human-readable state", () => {
      const s = summarizePr(
        makePr({
          mergeQueueEntry: { position: 3, state: "AWAITING_CHECKS" },
        }),
      );
      expect(s.facts[0]).toContain("position 3");
      expect(s.facts[0]).toContain("awaiting checks");
    });
  });

  describe("summary fields", () => {
    test("carries PR identity fields through", () => {
      const s = summarizePr(makePr());
      expect(s).toMatchObject({
        author: "stefan-burke",
        branch: "feature-branch",
        number: 42,
        title: "Some PR",
        updatedAt: "2026-07-10T12:00:00Z",
      });
    });

    test("falls back to 'unknown' author when none is present", () => {
      const s = summarizePr({ ...makePr(), author: null });
      expect(s.author).toBe("unknown");
    });
  });
});
