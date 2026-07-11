import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { truncationWarnings } from "../../../scripts/pr-queue/pagination.ts";
import type { GraphQlPr } from "../../../scripts/pr-queue/types.ts";
import { makePr } from "./fixtures.ts";

const rollupContexts = (pr: GraphQlPr) =>
  pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;

// The warnings quote the fetched page sizes verbatim, so they are pinned as
// literals here (not re-derived from PAGE_SIZES) — otherwise a mutant that
// changed a page size would pass a test that also read it from the same source.
describe("truncationWarnings", () => {
  test("no warnings when nothing was cut off", () => {
    expect(truncationWarnings([makePr()], false)).toEqual([]);
  });

  test("warns when there are more open PRs than the first page", () => {
    expect(truncationWarnings([makePr()], true)).toEqual([
      "More than 60 open PRs — only the 60 most recently updated are shown; older ones are omitted.",
    ]);
  });

  test("warns per PR when its review threads are truncated", () => {
    const pr = makePr();
    pr.reviewThreads.pageInfo.hasNextPage = true;
    expect(truncationWarnings([pr], false)).toEqual([
      "PR #42: more than 100 review threads — some open comments may be missing.",
    ]);
  });

  test("warns per PR when its requested reviewers are truncated", () => {
    const pr = makePr();
    pr.reviewRequests.pageInfo.hasNextPage = true;
    expect(truncationWarnings([pr], false)).toEqual([
      "PR #42: more than 20 requested reviewers — some may be missing.",
    ]);
  });

  test("warns per PR when its checks are truncated", () => {
    const pr = makePr();
    const contexts = rollupContexts(pr);
    if (!contexts) throw new Error("fixture must have a check rollup");
    contexts.pageInfo.hasNextPage = true;
    expect(truncationWarnings([pr], false)).toEqual([
      "PR #42: more than 50 checks — its CI status may be incomplete.",
    ]);
  });

  test("a PR with no CI rollup contributes no checks warning", () => {
    const pr = makePr({ checks: "none" });
    expect(truncationWarnings([pr], false)).toEqual([]);
  });

  test("collects every truncated connection across the queue", () => {
    const withThreads = makePr();
    withThreads.reviewThreads.pageInfo.hasNextPage = true;
    const withReviewers = makePr();
    withReviewers.reviewRequests.pageInfo.hasNextPage = true;
    const warnings = truncationWarnings([withThreads, withReviewers], true);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("More than");
    expect(warnings[1]).toContain("review threads");
    expect(warnings[2]).toContain("requested reviewers");
  });
});
