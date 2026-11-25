/**
 * Build one tutorial video from start to finish: check the evidence anchors,
 * record the real site, render the three.js scene, encode the MP4, and write the
 * committed freshness baseline. A failed build leaves the previous video in
 * place, because the new work happens in a temporary directory.
 */

import { join } from "@std/path";
import { removeIfPresent } from "#scripts/cleanup.ts";
import { projectRoot } from "#scripts/project-root.ts";
import type { EvidenceManifest } from "#scripts/specs/evidence/schema.ts";
import {
  type GuideFreshnessBaseline,
  parseGuideFreshnessBaseline,
} from "./baseline.ts";
import { copyPosterFrame, encodeFrames } from "./encode.ts";
import {
  EVIDENCE_MANIFEST,
  evidenceFingerprints,
  readEvidenceManifest,
} from "./evidence.ts";
import { type GuideGitState, guideGitState } from "./git.ts";
import { recordGuideSession } from "./record/run.ts";
import { removeTree } from "./remove-tree.ts";
import { renderGuideFromSession } from "./render/run.ts";
import {
  type GuideStoryboard,
  parseGuideStoryboard,
  storyboardEvidence,
} from "./storyboard.ts";
import { guideStoryboard } from "./storyboards/index.ts";
import { type GuideTimeline, parseGuideTimeline } from "./timeline.ts";
import { writeJson } from "./write-json.ts";

const REPORTS = join(projectRoot, "reports", "guides");
const GUIDES = join(projectRoot, "guides");

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

const withGuideLock = async <T>(
  slug: string,
  run: () => Promise<T>,
): Promise<T> => {
  await Deno.mkdir(REPORTS, { recursive: true });
  const path = join(REPORTS, `.${slug}.lock`);
  if (await exists(path)) {
    throw new Error(
      `Another build is recording ${slug}. Remove ${path} if no build is running.`,
    );
  }
  await Deno.writeTextFile(path, `${Deno.pid}\n`, { createNew: true });
  try {
    return await run();
  } finally {
    await removeIfPresent(path);
  }
};

const publish = async (tempDir: string, finalDir: string): Promise<void> => {
  const backup = `${finalDir}.backup-${crypto.randomUUID()}`;
  const hadFinal = await exists(finalDir);
  if (hadFinal) await Deno.rename(finalDir, backup);
  try {
    await Deno.rename(tempDir, finalDir);
  } catch (error) {
    if (hadFinal) await Deno.rename(backup, finalDir);
    throw error;
  }
  if (hadFinal) await removeTree(backup);
};

export interface RecordGuideOptions {
  allowDirty: boolean;
  fromSession?: string;
  keepFrames: boolean;
  keepSession: boolean;
  slug: string;
}

export interface RecordGuideResult {
  baselineWritten: boolean;
  durationMs: number;
  frameCount: number;
  guideDir: string;
  video: string;
}

interface PreparedGuide {
  current: Record<string, string>;
  git: GuideGitState;
  manifest: EvidenceManifest;
  storyboard: GuideStoryboard;
}

interface BuiltGuide {
  frameCount: number;
  framesDir: string;
  sessionDir: string;
  timeline: GuideTimeline;
}

const prepareGuide = async (
  options: RecordGuideOptions,
): Promise<PreparedGuide> => {
  const storyboard = parseGuideStoryboard(guideStoryboard(options.slug));
  const git = await guideGitState();
  if (git.dirty && !options.allowDirty) {
    throw new Error(
      "The worktree is dirty. Commit or clean it, or pass --allow-dirty to build without updating the baseline.",
    );
  }
  const manifest = await readEvidenceManifest(EVIDENCE_MANIFEST);
  const current = await evidenceFingerprints(
    manifest,
    EVIDENCE_MANIFEST,
    storyboardEvidence(storyboard),
  );
  return { current, git, manifest, storyboard };
};

const timelineFor = async (
  options: RecordGuideOptions,
  storyboard: GuideStoryboard,
  sessionDir: string,
): Promise<GuideTimeline> =>
  options.fromSession
    ? parseGuideTimeline(
        JSON.parse(
          await Deno.readTextFile(join(options.fromSession, "timeline.json")),
        ),
      )
    : recordGuideSession(storyboard, sessionDir);

const buildVideo = async (
  options: RecordGuideOptions,
  prepared: PreparedGuide,
  tempDir: string,
): Promise<BuiltGuide> => {
  const sessionDir = options.fromSession ?? join(tempDir, "session");
  const timeline = await timelineFor(options, prepared.storyboard, sessionDir);
  const framesDir = join(tempDir, "frames");
  const rendered = await renderGuideFromSession(sessionDir, framesDir);
  const video = join(tempDir, "guide.mp4");
  await encodeFrames({
    fps: timeline.viewport.fps,
    framesDir,
    outputPath: video,
  });
  const poster = join(tempDir, "poster.png");
  await copyPosterFrame(framesDir, poster, rendered.frameCount);
  return { frameCount: rendered.frameCount, framesDir, sessionDir, timeline };
};

const guideName = (
  prepared: PreparedGuide,
): { slug: string; title: string } => ({
  slug: prepared.storyboard.slug,
  title: prepared.storyboard.title,
});

const baselineFor = (prepared: PreparedGuide): GuideFreshnessBaseline =>
  parseGuideFreshnessBaseline({
    anchors: prepared.current,
    recordedCommit: prepared.git.commit,
    schemaVersion: 2,
  });

const writeGuideManifest = (
  tempDir: string,
  prepared: PreparedGuide,
  built: BuiltGuide,
): Promise<void> =>
  writeJson(join(tempDir, "manifest.json"), {
    commit: prepared.git.commit,
    durationMs: built.timeline.durationMs,
    evidenceCommit: prepared.manifest.app.commit,
    fps: built.timeline.viewport.fps,
    frameCount: built.frameCount,
    guide: guideName(prepared),
    poster: "poster.png",
    schemaVersion: 1,
    video: "guide.mp4",
  });

const writeBaseline = async (
  prepared: PreparedGuide,
  baseline: GuideFreshnessBaseline,
): Promise<void> => {
  const baselineDir = join(GUIDES, prepared.storyboard.slug);
  await Deno.mkdir(baselineDir, { recursive: true });
  await writeJson(join(baselineDir, "freshness.json"), baseline);
};

const removeIntermediates = async (
  options: RecordGuideOptions,
  built: BuiltGuide,
): Promise<void> => {
  if (!options.keepFrames) {
    await Deno.remove(built.framesDir, { recursive: true });
  }
  if (!options.keepSession && !options.fromSession) {
    await Deno.remove(built.sessionDir, { recursive: true });
  }
};

const buildGuide = async (
  options: RecordGuideOptions,
): Promise<RecordGuideResult> => {
  const prepared = await prepareGuide(options);
  await Deno.mkdir(REPORTS, { recursive: true });
  const tempDir = await Deno.makeTempDir({
    dir: REPORTS,
    prefix: `.${options.slug}-`,
  });
  try {
    const built = await buildVideo(options, prepared, tempDir);
    await writeGuideManifest(tempDir, prepared, built);
    await removeIntermediates(options, built);
    const baselineWritten = !prepared.git.dirty;
    if (baselineWritten) await writeBaseline(prepared, baselineFor(prepared));
    const finalDir = join(REPORTS, prepared.storyboard.slug);
    await publish(tempDir, finalDir);
    return {
      baselineWritten,
      durationMs: built.timeline.durationMs,
      frameCount: built.frameCount,
      guideDir: finalDir,
      video: join(finalDir, "guide.mp4"),
    };
  } catch (error) {
    await removeTree(tempDir);
    throw error;
  }
};

export const recordGuide = (
  options: RecordGuideOptions,
): Promise<RecordGuideResult> =>
  withGuideLock(options.slug, () => buildGuide(options));
