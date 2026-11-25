#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "@std/cli/parse-args";
import { checkGuides } from "#scripts/guides/check.ts";
import {
  freshnessReportLines,
  type GuideAnchorFreshness,
  type GuideNeedingAttention,
  staleGuides,
} from "#scripts/guides/freshness.ts";
import { projectRoot } from "#scripts/project-root.ts";

/** The answer typed at the prompt. Null when the runtime has no prompt or the
 * person closed it. */
const askOrNull = (message: string): string | null => {
  const prompt = Reflect.get(globalThis, "prompt");
  if (typeof prompt !== "function") return null;
  const answer: unknown = Reflect.apply(prompt, globalThis, [message]);
  return typeof answer === "string" ? answer : null;
};

const refresh = async (slug: string): Promise<void> => {
  console.log(`\nRecording ${slug}...`);
  const status = await new Deno.Command(Deno.execPath(), {
    args: ["task", "guide:record", slug],
    cwd: projectRoot,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`Recording ${slug} failed`);
};

const staleDetail = (anchors: readonly GuideAnchorFreshness[]): string =>
  anchors.length === 0
    ? ""
    : ` The stale parts are ${anchors
        .map(({ captureId, percent }) => `${captureId} ${percent}%`)
        .join(", ")}.`;

const printChoices = (slug: string, summary: string): void => {
  console.log(`  ${summary}`);
  console.log(`  Refresh now: deno task guide:record ${slug}`);
  console.log("  Or leave it for a separate branch.");
};

const askToRefresh = async (slug: string, summary: string): Promise<void> => {
  const answer = askOrNull(
    `${summary} [1] refresh now, [2] leave for a separate branch: `,
  );
  if (answer?.trim() === "1") await refresh(slug);
  else console.log(`Left ${slug} for a separate branch.`);
};

/** Ask at a terminal. Elsewhere, such as in CI, print the choices. */
const offerRefresh = async ({
  anchors,
  guide,
}: GuideNeedingAttention): Promise<void> => {
  const summary = `${guide.slug} is ${guide.percent}% fresh.${staleDetail(anchors)}`;
  if (Deno.stdin.isTerminal()) await askToRefresh(guide.slug, summary);
  else printChoices(guide.slug, summary);
};

const main = async (): Promise<void> => {
  const options = parseArgs(Deno.args, { string: ["guide"] });
  const report = await checkGuides(options.guide);
  if (!report) {
    console.log(
      "No guide baselines yet. Record one with deno task guide:record <slug>.",
    );
    return;
  }
  console.log(freshnessReportLines(report).join("\n"));
  const stale = staleGuides(report);
  if (stale.length === 0) return;
  console.log(
    `\nWarning: ${stale.length} guide(s) need attention (below ${report.warnBelowPercent}%).`,
  );
  for (const guide of stale) await offerRefresh(guide);
};

if (import.meta.main) await main();
