/**
 * Turn a recorded session into the static files an iframe loads: a rewritten
 * timeline, WebP frames, and the player page. The video build keeps the JPEG
 * frames; this package trades some motion detail for a smaller modal download.
 */

import { join } from "@std/path";
import sharp from "sharp";
import { frameFileName } from "./frame-name.ts";
import { playerPage } from "./player-page.ts";
import { readGuideTimeline } from "./session-timeline.ts";
import type { GuideTimeline } from "./timeline.ts";
import { writeJson } from "./write-json.ts";

export const PACKAGED_FPS = 15;
const WEBP_QUALITY = 60;

export interface PackagedGuide {
  timeline: GuideTimeline;
}

export const packageGuideAnimation = async (
  sessionDir: string,
  guideDir: string,
): Promise<PackagedGuide> => {
  const timeline = await readGuideTimeline(sessionDir);
  await Deno.mkdir(join(guideDir, "frames"), { recursive: true });

  const kept = timeline.frames.filter((_frame, index) => index % 2 === 0);
  const last = timeline.frames.at(-1);
  if (last !== undefined && kept.at(-1) !== last) kept.push(last);

  const frames: Array<{ atMs: number; file: string }> = [];
  for (const frame of kept) {
    const bytes = await Deno.readFile(join(sessionDir, frame.file));
    const webp = await sharp(bytes).webp({ quality: WEBP_QUALITY }).toBuffer();
    const file = frameFileName(frames.length + 1, "webp");
    await Deno.writeFile(join(guideDir, "frames", file), webp);
    frames.push({ atMs: frame.atMs, file });
  }

  const packaged: GuideTimeline = {
    ...timeline,
    frames,
    viewport: { ...timeline.viewport, fps: PACKAGED_FPS },
  };
  await writeJson(join(guideDir, "timeline.json"), packaged);
  await Deno.writeTextFile(
    join(guideDir, "index.html"),
    playerPage({
      autoplay: true,
      guideTitle: timeline.guide.title,
      scriptSrc: "../player.js",
    }),
  );
  return { timeline: packaged };
};
