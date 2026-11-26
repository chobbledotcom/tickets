import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser } from "playwright";
import sharp from "sharp";
import { launchGuideBrowser } from "#scripts/guides/browser.ts";
import { recordSession } from "#scripts/guides/record/session.ts";
import type { GuideAction } from "#scripts/guides/storyboard.ts";
import { parseGuideTimeline } from "#scripts/guides/timeline.ts";
import { GUIDE_DEVICE_SCALE_FACTOR } from "#scripts/guides/video.ts";
import { DESKTOP_SCREENSHOT_PROFILE } from "#scripts/screenshots/profile.ts";
import { launchScreenshotBrowser } from "#test/scripts/screenshots-browser-helpers.ts";
import { newGuidePage } from "./browser-helpers.ts";

const VIEWPORT = { height: 600, width: 800 };

const pageHtml = `<!doctype html>
<html>
<body style="margin:0;font:20px sans-serif;background:#fff">
  <p style="height:200px">Top of the page</p>
  <label>Name <input id="name" name="name"></label>
  <button id="go" type="button" onclick="this.textContent='done'">Go</button>
  <div style="height:1200px">Long page</div>
</body>
</html>`;

const actions: GuideAction[] = [
  { kind: "focus", scale: 0.6, selector: "#name", transitionMs: 100 },
  { kind: "wait", ms: 150 },
  { kind: "type", perCharacterMs: 10, selector: "#name", text: "abc" },
  { kind: "blur", transitionMs: 100 },
  { kind: "click", selector: "#go" },
  { deltaY: 400, kind: "scroll", settleMs: 30, steps: 4 },
  { kind: "wait", ms: 150 },
];

const frameSize = async (
  path: string,
): Promise<{ height: number | undefined; width: number | undefined }> => {
  const metadata = await sharp(await Deno.readFile(path)).metadata();
  return { height: metadata.height, width: metadata.width };
};

describe("guide recorder browser contract", () => {
  let browser: Browser;
  let directory: string;

  beforeAll(async () => {
    browser = await launchScreenshotBrowser();
    directory = await Deno.makeTempDir({ prefix: "guide-recorder-" });
  });

  afterAll(async () => {
    await browser.close();
    await Deno.remove(directory, { recursive: true });
  });

  test("records a typed field, a click, and a scroll", async () => {
    const page = await newGuidePage(
      browser,
      VIEWPORT,
      `data:text/html,${encodeURIComponent(pageHtml)}`,
    );
    try {
      const timeline = await recordSession(page, {
        actions,
        fps: 30,
        guide: { slug: "recorder-test", title: "Recorder test" },
        outputDir: directory,
        viewport: VIEWPORT,
      });

      expect(await page.locator("#name").inputValue()).toBe("abc");
      expect(await page.locator("#go").textContent()).toBe("done");
      expect(timeline.frames[0]?.atMs).toBe(0);
      expect(timeline.frames.length).toBeGreaterThan(0);
      expect(
        timeline.events
          .map(({ kind }) => kind)
          .filter((kind) => kind !== "cursor"),
      ).toEqual(["focus", "click", "blur", "click"]);
      expect(timeline.durationMs).toBeGreaterThan(1000);

      const parsed = parseGuideTimeline(
        JSON.parse(await Deno.readTextFile(join(directory, "timeline.json"))),
      );
      expect(parsed.guide.slug).toBe("recorder-test");
      expect(await frameSize(join(directory, "frame-00001.jpg"))).toEqual({
        height: VIEWPORT.height,
        width: VIEWPORT.width,
      });
    } finally {
      await page.close();
    }
  });

  test("records the screencast at two device pixels per CSS pixel", async () => {
    const guideBrowser = await launchGuideBrowser();
    const output = await Deno.makeTempDir({ prefix: "guide-recorder-2x-" });
    const desktop = DESKTOP_SCREENSHOT_PROFILE.viewport;
    const page = await newGuidePage(
      guideBrowser,
      desktop,
      `data:text/html,${encodeURIComponent(pageHtml)}`,
    );
    try {
      await recordSession(page, {
        actions: [{ kind: "wait", ms: 200 }],
        fps: 30,
        guide: { slug: "recorder-scale", title: "Recorder scale" },
        outputDir: output,
        viewport: desktop,
      });
      expect(await frameSize(join(output, "frame-00001.jpg"))).toEqual({
        height: desktop.height * GUIDE_DEVICE_SCALE_FACTOR,
        width: desktop.width * GUIDE_DEVICE_SCALE_FACTOR,
      });
    } finally {
      await page.close();
      await guideBrowser.close();
      await Deno.remove(output, { recursive: true });
    }
  });
});
