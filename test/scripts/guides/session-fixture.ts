/** A recorded-looking session for the render and publish tests: small JPEG
 * frames, a timeline, and the guide title. */

import { join } from "@std/path";
import sharp from "sharp";

export const writeGuideSession = async (
  directory: string,
  frameCount = 3,
  frameStepMs = 100,
): Promise<void> => {
  await Deno.mkdir(directory, { recursive: true });
  const frames: Array<{ atMs: number; file: string }> = [];
  for (let index = 0; index < frameCount; index += 1) {
    const file = `frame-${String(index + 1).padStart(5, "0")}.jpg`;
    const bytes = await sharp({
      create: {
        background: { b: 0, g: 0, r: index * 60 },
        channels: 3,
        height: 18,
        width: 32,
      },
    })
      .jpeg()
      .toBuffer();
    await Deno.writeFile(join(directory, file), bytes);
    frames.push({ atMs: index * frameStepMs, file });
  }
  await Deno.writeTextFile(
    join(directory, "timeline.json"),
    JSON.stringify({
      durationMs: Math.max(1000, (frameCount - 1) * frameStepMs),
      events: [],
      frames,
      guide: { slug: "create-a-listing", title: "Create a listing" },
      schemaVersion: 1,
      viewport: { fps: 30, height: 18, width: 32 },
    }),
  );
};
