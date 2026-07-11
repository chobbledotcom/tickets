import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { renderReport } from "../../../scripts/pr-queue/render.ts";
import type { Bucket, PrSummary } from "../../../scripts/pr-queue/types.ts";

/** A frozen clock so `ago`/stale output is deterministic. 2026-07-10T13:00:00Z. */
const NOW = Date.UTC(2026, 6, 10, 13); // month is 0-indexed (6 = July)
const clock = (): number => NOW;

const summary = (over: Partial<PrSummary> & { bucket: Bucket }): PrSummary => ({
  author: "stefan-burke",
  branch: "feature-branch",
  facts: ["is ready to merge — all checks pass, no open comments"],
  number: 42,
  title: "Some PR",
  updatedAt: "2026-07-10T12:00:00Z",
  ...over,
});

describe("renderReport", () => {
  test("an empty queue announces no open pull requests", () => {
    const out = renderReport("o/n", [], clock);
    expect(out).toContain("PR queue — o/n — 0 open");
    expect(out).toContain("No open pull requests.");
  });

  test("the header names every bucket count in order, comma-separated", () => {
    const out = renderReport(
      "o/n",
      [
        summary({ bucket: "READY", number: 1 }),
        summary({ bucket: "ATTENTION", number: 2 }),
      ],
      clock,
    );
    // Full header pins the count for each bucket (0 for the empty ones), the
    // ", " separators, and the lower-cased bucket labels all at once.
    expect(out).toContain(
      "PR queue — o/n — 2 open (1 needs attention, 0 in merge queue, 0 waiting, 0 draft, 1 ready to merge)",
    );
  });

  test("renders groups in most-pressing-first order regardless of input order", () => {
    const out = renderReport(
      "o/n",
      [
        summary({ branch: "ready-br", bucket: "READY", number: 1 }),
        summary({ branch: "waiting-br", bucket: "WAITING", number: 2 }),
        summary({ branch: "attention-br", bucket: "ATTENTION", number: 3 }),
      ],
      clock,
    );
    const attentionIdx = out.indexOf("attention-br");
    const waitingIdx = out.indexOf("waiting-br");
    const readyIdx = out.indexOf("ready-br");
    expect(attentionIdx).toBeLessThan(waitingIdx);
    expect(waitingIdx).toBeLessThan(readyIdx);
  });

  test("the status line names the branch and PR number, then ends facts with a full stop", () => {
    const out = renderReport(
      "o/n",
      [
        summary({
          branch: "fix-foo",
          bucket: "ATTENTION",
          facts: ["is behind main and needs main merged in"],
          number: 7,
        }),
      ],
      clock,
    );
    // The branch tag is wrapped in ANSI colour codes, so the "branch … (PR n)"
    // label and the fact sentence are matched separately rather than as one run.
    expect(out).toContain("branch fix-foo (PR 7)");
    expect(out).toContain("is behind main and needs main merged in.");
    // The header line names the PR, author, and a "1h ago" age (12:00 vs the
    // 13:00 clock), with the age immediately followed by the closing paren.
    expect(out).toContain("(by stefan-burke, 1h ago)");
  });

  test("multiple facts for one PR are joined with '; ' and end in a full stop", () => {
    const out = renderReport(
      "o/n",
      [
        summary({
          bucket: "DRAFT",
          facts: ["is still a draft", "has failing checks (test)"],
        }),
      ],
      clock,
    );
    expect(out).toContain("is still a draft; has failing checks (test).");
  });

  test("a merge-queued PR renders under the IN MERGE QUEUE group", () => {
    const out = renderReport(
      "o/n",
      [summary({ bucket: "QUEUED", facts: ["is in GitHub's merge queue"] })],
      clock,
    );
    expect(out).toContain("IN MERGE QUEUE (1)");
  });

  test("the report is a header followed by a blank line before the first group", () => {
    // renderReport joins its lines with newlines and separates each group with a
    // leading blank line; this pins both the "\n" join and that blank spacer.
    const lines = renderReport(
      "o/n",
      [summary({ bucket: "READY", number: 1 })],
      clock,
    ).split("\n");
    expect(lines[1]).toBe("");
    expect(lines.length).toBeGreaterThan(2);
  });

  test("PRs older than a week show a day-count age and are flagged stale", () => {
    const out = renderReport(
      "o/n",
      [summary({ bucket: "WAITING", updatedAt: "2026-06-01T00:00:00Z" })],
      clock,
    );
    // 2026-06-01 → 2026-07-10T13:00 is 39 days, past the one-week stale line.
    expect(out).toContain("39d ago, stale");
  });

  test("a PR updated seconds ago still reads at least '1m ago'", () => {
    // 30 seconds floors to 0 minutes; the age is clamped up to a minimum of 1.
    const out = renderReport(
      "o/n",
      [summary({ bucket: "READY", updatedAt: "2026-07-10T12:59:30Z" })],
      clock,
    );
    expect(out).toContain("1m ago");
    expect(out).not.toContain("0m ago");
  });

  test("a PR updated today is not flagged stale", () => {
    const out = renderReport(
      "o/n",
      [summary({ bucket: "READY", updatedAt: "2026-07-10T11:00:00Z" })],
      clock,
    );
    // "stale" should not appear anywhere for a fresh PR.
    expect(out.includes("stale")).toBe(false);
  });

  test("a PR updated only minutes ago is tagged with an 'm ago' suffix", () => {
    // 12:55 is five minutes before the 13:00 clock — under an hour, so the
    // age falls through the days/hours branches to the minutes one.
    const out = renderReport(
      "o/n",
      [summary({ bucket: "READY", updatedAt: "2026-07-10T12:55:00Z" })],
      clock,
    );
    expect(out).toContain("5m ago");
    expect(out).not.toContain("h ago");
    expect(out).not.toContain("d ago");
  });

  test("within one bucket, the most recently updated PR is listed first", () => {
    // Two READY PRs: the 12:00 one is more recent than the 10:00 one, so it
    // must surface at the top of the group even though it was added second.
    const out = renderReport(
      "o/n",
      [
        summary({
          branch: "older",
          bucket: "READY",
          number: 1,
          updatedAt: "2026-07-10T10:00:00Z",
        }),
        summary({
          branch: "newer",
          bucket: "READY",
          number: 2,
          updatedAt: "2026-07-10T12:00:00Z",
        }),
      ],
      clock,
    );
    expect(out.indexOf("newer")).toBeLessThan(out.indexOf("older"));
  });

  test("output is deterministic for a fixed clock (same input ⇒ same output)", () => {
    const input = [
      summary({
        bucket: "ATTENTION",
        facts: ["is held up by merge conflicts (needs a rebase)"],
        number: 1,
      }),
      summary({ bucket: "READY", number: 2 }),
    ];
    expect(renderReport("o/n", input, clock)).toBe(
      renderReport("o/n", input, clock),
    );
  });
});
