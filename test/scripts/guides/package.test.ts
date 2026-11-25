import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import {
  type PackagedGuide,
  packageGuideAnimation,
} from "#scripts/guides/package.ts";
import { parseGuideTimeline } from "#scripts/guides/timeline.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { writeGuideSession } from "./session-fixture.ts";

/** Package one fixture session in a temporary directory. */
const withPackage = async (
  frameCount: number,
  run: (guide: string, packaged: PackagedGuide) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: "guide-package-test-" });
  try {
    const session = join(root, "session");
    const guide = join(root, "guide");
    await writeGuideSession(session, frameCount);
    await run(guide, await packageGuideAnimation(session, guide));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

describe("packageGuideAnimation", () => {
  test("keeps every other frame as WebP and rewrites the timeline", async () => {
    await withPackage(3, async (guide, packaged) => {
      expect(packaged.timeline.frames).toEqual([
        { atMs: 0, file: "frame-00001.webp" },
        { atMs: 200, file: "frame-00002.webp" },
      ]);
      expect(packaged.timeline.viewport.fps).toBe(15);
      expect(packaged.timeline.durationMs).toBe(1000);
      expect(packaged.timeline.guide.title).toBe("Create a listing");

      const metadata = await sharp(
        await Deno.readFile(join(guide, "frames", "frame-00001.webp")),
      ).metadata();
      expect(metadata.format).toBe("webp");

      const written = parseGuideTimeline(
        JSON.parse(await Deno.readTextFile(join(guide, "timeline.json"))),
      );
      expect(written.frames.map(({ file }) => file)).toEqual([
        "frame-00001.webp",
        "frame-00002.webp",
      ]);

      const html = await Deno.readTextFile(join(guide, "index.html"));
      expectIncludesAll(html, [
        "<title>Create a listing</title>",
        "globalThis.__GUIDE_AUTOPLAY__ = true;",
        'src="../player.js"',
      ]);
    });
  });

  test("keeps the final frame when the count is even", async () => {
    await withPackage(4, async (guide, packaged) => {
      expect(packaged.timeline.frames.map(({ atMs }) => atMs)).toEqual([
        0, 200, 300,
      ]);
      assertStringIncludes(
        await Deno.readTextFile(join(guide, "timeline.json")),
        "frame-00003.webp",
      );
    });
  });
});
