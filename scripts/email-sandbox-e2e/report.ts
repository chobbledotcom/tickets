/**
 * Turn leg outcomes into the report the run hands back: one console line per
 * leg, one Markdown table for the job's step summary, and the verdict.
 */

import type { EmailLegOutcome } from "./run.ts";

const STATE_WORDS: Record<EmailLegOutcome["state"], string> = {
  failed: "❌ failed",
  sent: "✅ sent",
  skipped: "⏭️ skipped",
};

/** One leg's console line. */
export const outcomeLine = (outcome: EmailLegOutcome): string =>
  `${outcome.provider}: ${STATE_WORDS[outcome.state]} — ${outcome.detail}`;

/** The Markdown table for the job's step summary panel. */
export const emailSummaryMarkdown = (outcomes: EmailLegOutcome[]): string =>
  [
    "\n## Live email providers\n",
    "provider | outcome | detail",
    "--- | --- | ---",
    ...outcomes.map(
      (outcome) =>
        `${outcome.provider} | ${STATE_WORDS[outcome.state]} | ${outcome.detail}`,
    ),
    "",
  ].join("\n");

export const failedProviders = (outcomes: EmailLegOutcome[]): string[] =>
  outcomes
    .filter((outcome) => outcome.state === "failed")
    .map((outcome) => outcome.provider);

export const everyLegSkipped = (outcomes: EmailLegOutcome[]): boolean =>
  outcomes.every((outcome) => outcome.state === "skipped");

/** The pass line's count of legs that really reached a provider. */
export const sentCount = (outcomes: EmailLegOutcome[]): number =>
  outcomes.filter((outcome) => outcome.state === "sent").length;
