#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "@std/cli/parse-args";
import { checkGuides } from "./guides/check-guide.ts";
import { freshnessReportLines, staleGuides } from "./guides/freshness.ts";
import { projectRoot } from "./project-root.ts";

const ask = (message: string): string | null => {
  const prompt = Reflect.get(globalThis, "prompt");
  if (typeof prompt !== "function") return null;
  return Reflect.apply(prompt, globalThis, [message]) as string | null;
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

const main = async (): Promise<void> => {
  const options = parseArgs(Deno.args, { string: ["guide"] });
  const report = await checkGuides(
    options.guide ? String(options.guide) : undefined,
  );
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
  for (const { anchors, guide } of stale) {
    const staleAnchors = anchors
      .map(({ captureId, percent }) => `${captureId} ${percent}%`)
      .join(", ");
    const detail =
      staleAnchors === "" ? "" : ` The stale parts are ${staleAnchors}.`;
    if (!Deno.stdin.isTerminal()) {
      console.log(`  ${guide.slug} is ${guide.percent}% fresh.${detail}`);
      console.log(`  Refresh now: deno task guide:record ${guide.slug}`);
      console.log("  Or leave it for a separate branch.");
      continue;
    }
    const answer = ask(
      `${guide.slug} is ${guide.percent}% fresh.${detail} [1] refresh now, [2] leave for a separate branch: `,
    );
    if (answer?.trim() === "1") {
      await refresh(guide.slug);
    } else {
      console.log(`Left ${guide.slug} for a separate branch.`);
    }
  }
};

if (import.meta.main) await main();
