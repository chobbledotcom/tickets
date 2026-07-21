import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { summarizePr } from "#scripts/pr-queue/summary.ts";
import { makePr } from "./fixtures.ts";

describe("summarizePr review comments", () => {
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
    expect(s.facts).toEqual([
      "has open comments from Codex (1 current, 1 outdated), CodeRabbit (1 current)",
    ]);
  });

  test("only-outdated comments wait (reviewer's move to re-resolve)", () => {
    const s = summarizePr(
      makePr({
        threads: [{ author: "chatgpt-codex-connector", outdated: true }],
      }),
    );
    expect(s.bucket).toBe("WAITING");
    expect(s.facts).toEqual(["has open comments from Codex (1 outdated)"]);
  });

  test("resolved threads never count toward the comment phrase", () => {
    const s = summarizePr(
      makePr({
        threads: [{ author: "chatgpt-codex-connector", resolved: true }],
      }),
    );
    expect(s.bucket).toBe("READY");
    expect(s.facts).toEqual([
      "is ready to merge — all checks pass, no open comments",
    ]);
  });

  test("an unresolved thread with no author still counts, under an unknown reviewer", () => {
    // A ghost/deleted first commenter must not make an open thread vanish — an
    // unresolved thread means the PR is not ready, so it surfaces as ATTENTION.
    const s = summarizePr(
      makePr({ threads: [{ author: null }, { author: "alice" }] }),
    );
    expect(s.bucket).toBe("ATTENTION");
    expect(s.facts).toEqual([
      "has open comments from an unknown reviewer (1 current), alice (1 current)",
    ]);
  });

  test("a lone authorless unresolved thread alone blocks READY", () => {
    const s = summarizePr(makePr({ threads: [{ author: null }] }));
    expect(s.bucket).toBe("ATTENTION");
    expect(s.facts).toEqual([
      "has open comments from an unknown reviewer (1 current)",
    ]);
  });

  test("an empty first-comment author reads as an unknown reviewer too", () => {
    // An empty login is as good as no author — it must not phrase a nameless
    // "( 1 current)" commenter; it collapses to the unknown-reviewer label.
    const s = summarizePr(makePr({ threads: [{ author: "" }] }));
    expect(s.bucket).toBe("ATTENTION");
    expect(s.facts).toEqual([
      "has open comments from an unknown reviewer (1 current)",
    ]);
  });
});

describe("summarizePr review requests", () => {
  test("a review request with no requested reviewer is ignored", () => {
    // The null `requestedReviewer` must be dropped, leaving the named reviewers
    // phrased in their original order.
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
    expect(s.facts).toEqual(["is waiting on a review from alice, infra-team"]);
  });

  test("a single requested reviewer still waits and names them", () => {
    const s = summarizePr(makePr({ reviewers: [{ login: "alice" }] }));
    expect(s.bucket).toBe("WAITING");
    expect(s.facts).toEqual(["is waiting on a review from alice"]);
  });
});

describe("summarizePr summary fields", () => {
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

  test("falls back to 'unknown' author when the login is empty", () => {
    const s = summarizePr({ ...makePr(), author: { login: "" } });
    expect(s.author).toBe("unknown");
  });
});
