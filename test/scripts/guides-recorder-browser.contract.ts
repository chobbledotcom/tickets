import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser } from "playwright";
import sharp from "sharp";
import { withStrictBrowserTimeouts } from "#scripts/browser-options.ts";
import { recordSession } from "#scripts/guides/record/session.ts";
import type { GuideAction } from "#scripts/guides/storyboard.ts";
import { parseGuideTimeline } from "#scripts/guides/timeline.ts";
import { launchScreenshotBrowser } from "./screenshots-browser-helpers.ts";

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
    const page = await browser.newPage({ viewport: VIEWPORT });
    withStrictBrowserTimeouts(page);
    try {
      await page.goto(`data:text/html,${encodeURIComponent(pageHtml)}`, {
        waitUntil: "domcontentloaded",
      });
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

      const metadata = await sharp(
        await Deno.readFile(join(directory, "frame-00001.jpg")),
      ).metadata();
      expect(metadata.width).toBe(VIEWPORT.width);
      expect(metadata.height).toBe(VIEWPORT.height);
    } finally {
      await page.close();
    }
  });
});
