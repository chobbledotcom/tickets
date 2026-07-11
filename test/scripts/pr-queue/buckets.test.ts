import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { summarizePr } from "../../../scripts/pr-queue/summary.ts";
import { makePr, type PrFixture } from "./fixtures.ts";

describe("summarizePr buckets and facts", () => {
  describe("one signal, one bucket and exact fact", () => {
    // Each case toggles a single status axis, so exactly one fact fires. The
    // fact is asserted in full (not by substring) so accidental wording drift
    // is caught.
    const cases: Array<{
      name: string;
      opts: PrFixture;
      bucket: string;
      fact: string;
    }> = [
      {
        bucket: "READY",
        fact: "is ready to merge — all checks pass, no open comments",
        name: "clean PR is READY and reads ready to merge",
        opts: {},
      },
      {
        bucket: "DRAFT",
        fact: "is still a draft",
        name: "draft lands in DRAFT",
        opts: { draft: true },
      },
      {
        bucket: "ATTENTION",
        fact: "is held up by merge conflicts (needs a rebase)",
        name: "a CONFLICTING mergeable flag alone needs attention and a rebase",
        opts: { mergeable: "CONFLICTING" },
      },
      {
        bucket: "ATTENTION",
        fact: "is held up by merge conflicts (needs a rebase)",
        name: "a DIRTY merge state alone needs attention and a rebase",
        opts: { mergeStateStatus: "DIRTY" },
      },
      {
        bucket: "ATTENTION",
        fact: "has changes requested by reviewers",
        name: "changes requested needs attention",
        opts: { reviewDecision: "CHANGES_REQUESTED" },
      },
      {
        bucket: "ATTENTION",
        fact: "has failing checks (test, lint)",
        name: "failing checks need attention and name them",
        opts: { checks: { failing: ["test", "lint"] } },
      },
      {
        bucket: "ATTENTION",
        fact: "is behind main and needs main merged in",
        name: "behind main needs attention",
        opts: { mergeStateStatus: "BEHIND" },
      },
      {
        bucket: "WAITING",
        fact: "is blocked by branch protection (missing a required review or status check)",
        name: "blocked by branch protection waits",
        opts: { mergeStateStatus: "BLOCKED" },
      },
      {
        bucket: "WAITING",
        fact: "has checks still running (test, typecheck)",
        name: "pending checks wait and name every one",
        opts: {
          checks: { passing: ["build"], pending: ["test", "typecheck"] },
        },
      },
      {
        bucket: "WAITING",
        fact: "is waiting on a review from alice, infra-team",
        name: "pending review request waits and names the reviewer",
        opts: { reviewers: [{ login: "alice" }, { name: "infra-team" }] },
      },
      {
        bucket: "WAITING",
        fact: "GitHub is still computing mergeability — re-run shortly to confirm whether it can merge",
        name: "mergeable UNKNOWN waits for GitHub to compute",
        opts: { mergeable: "UNKNOWN" },
      },
      {
        bucket: "WAITING",
        fact: "GitHub is still computing the merge state — re-run shortly to confirm whether it can merge",
        name: "merge state UNKNOWN waits even when mergeable resolved",
        opts: { mergeStateStatus: "UNKNOWN" },
      },
      {
        bucket: "WAITING",
        fact: "has no CI checks yet",
        name: "no CI rollup waits and flags no checks",
        opts: { checks: "none" },
      },
      {
        bucket: "QUEUED",
        fact: "is in GitHub's merge queue (position 1, awaiting checks) — do not push to this branch",
        name: "a merge-queued PR lands in its own bucket and warns against pushing",
        opts: { mergeQueueEntry: { position: 1, state: "AWAITING_CHECKS" } },
      },
    ];

    for (const { name, opts, bucket, fact } of cases) {
      test(name, () => {
        const s = summarizePr(makePr(opts));
        expect(s.bucket).toBe(bucket);
        expect(s.facts).toEqual([fact]);
      });
    }
  });

  test("behind fact names the PR's actual base branch, not always main", () => {
    const s = summarizePr(
      makePr({ baseRefName: "develop", mergeStateStatus: "BEHIND" }),
    );
    expect(s.bucket).toBe("ATTENTION");
    expect(s.facts).toEqual(["is behind develop and needs develop merged in"]);
  });

  test("merge state UNKNOWN does not double up while mergeability is also unknown", () => {
    const s = summarizePr(
      makePr({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    );
    // Only the mergeability fact fires — the merge-state signal is guarded on
    // mergeable so the two never both report "still computing".
    expect(s.facts).toEqual([
      "GitHub is still computing mergeability — re-run shortly to confirm whether it can merge",
    ]);
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
      // Behind (attention) is listed before pending checks (waiting) in order.
      expect(s.facts).toEqual([
        "is behind main and needs main merged in",
        "has checks still running (test)",
      ]);
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
      expect(s.facts).toEqual([
        "is held up by merge conflicts (needs a rebase)",
      ]);
    });

    test("merge queue outranks attention — a queued PR with open comments stays QUEUED", () => {
      const s = summarizePr(
        makePr({
          mergeQueueEntry: { position: 1, state: "AWAITING_CHECKS" },
          threads: [{ author: "chatgpt-codex-connector" }],
        }),
      );
      expect(s.bucket).toBe("QUEUED");
      expect(s.facts).toEqual([
        "is in GitHub's merge queue (position 1, awaiting checks) — do not push to this branch",
        "has open comments from Codex (1 current)",
      ]);
    });

    test("merge-queue fact shows position and human-readable state", () => {
      const s = summarizePr(
        makePr({ mergeQueueEntry: { position: 3, state: "AWAITING_CHECKS" } }),
      );
      expect(s.facts).toEqual([
        "is in GitHub's merge queue (position 3, awaiting checks) — do not push to this branch",
      ]);
    });
  });
});
