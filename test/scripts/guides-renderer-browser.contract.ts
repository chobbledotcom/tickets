import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser, Page } from "playwright";
import sharp from "sharp";
import { withStrictBrowserTimeouts } from "#scripts/browser-options.ts";
import { startGuideRenderServer } from "#scripts/guides/render/server.ts";
import type { GuideTimeline } from "#scripts/guides/timeline.ts";
import { launchScreenshotBrowser } from "./screenshots-browser-helpers.ts";

const VIEWPORT = { height: 720, width: 1280 };

const frameWithBlock = async (
  background: { b: number; g: number; r: number },
  left: number,
  top: number,
): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
      create: {
        background: { b: 255, g: 255, r: 255 },
        channels: 3,
        height: VIEWPORT.height,
        width: VIEWPORT.width,
      },
    })
      .composite([
        {
          input: {
            create: {
              background,
              channels: 3,
              height: 100,
              width: 200,
            },
          },
          left,
          top,
        },
      ])
      .jpeg()
      .toBuffer(),
  );

const countPixels = async (
  png: Uint8Array,
  wanted: (red: number, green: number, blue: number) => boolean,
): Promise<number> => {
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    if (wanted(data[index]!, data[index + 1]!, data[index + 2]!)) count += 1;
  }
  return count;
};

interface RenderResult {
  camera: { zoom: number };
  frame: string;
}

const renderAt = (page: Page, atMs: number): Promise<RenderResult> =>
  page.evaluate((time) => {
    const render = Reflect.get(globalThis, "renderAt") as (
      value: number,
    ) => Promise<RenderResult>;
    return render(time);
  }, atMs);

const timeline: GuideTimeline = {
  durationMs: 2000,
  events: [
    { atMs: 0, kind: "cursor", x: 100, y: 100 },
    {
      atMs: 200,
      kind: "focus",
      rect: { height: 100, width: 200, x: 100, y: 100 },
      scale: 0.5,
      transitionMs: 200,
    },
    { atMs: 400, kind: "click", x: 100, y: 100 },
    { atMs: 1000, kind: "blur", transitionMs: 200 },
  ],
  frames: [
    { atMs: 0, file: "frame-00001.jpg" },
    { atMs: 1000, file: "frame-00002.jpg" },
  ],
  guide: { slug: "renderer-test", title: "Renderer test" },
  schemaVersion: 1,
  viewport: { fps: 30, ...VIEWPORT },
};

describe("guide renderer browser contract", () => {
  let browser: Browser;
  let server: Awaited<ReturnType<typeof startGuideRenderServer>>;
  let directory: string;

  beforeAll(async () => {
    directory = await Deno.makeTempDir({ prefix: "guide-renderer-" });
    await Deno.writeFile(
      join(directory, "frame-00001.jpg"),
      await frameWithBlock({ b: 0, g: 0, r: 255 }, 100, 100),
    );
    await Deno.writeFile(
      join(directory, "frame-00002.jpg"),
      await frameWithBlock({ b: 255, g: 0, r: 0 }, 600, 400),
    );
    await Deno.writeTextFile(
      join(directory, "timeline.json"),
      JSON.stringify(timeline),
    );
    server = await startGuideRenderServer(directory, VIEWPORT);
    browser = await launchScreenshotBrowser();
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  });

  const openPage = async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    withStrictBrowserTimeouts(page);
    await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => Reflect.get(globalThis, "rendererReady") === true,
    );
    return page;
  };

  test("shows the first frame and hides nothing before a focus", async () => {
    const page = await openPage();
    try {
      const result = await renderAt(page, 0);
      expect(result.frame).toBe("frame-00001.jpg");
      expect(result.camera.zoom).toBe(1);
      const png = await page.screenshot({ type: "png" });
      expect(
        await countPixels(
          png,
          (red, green, blue) => red > 200 && green < 80 && blue < 80,
        ),
      ).toBeGreaterThan(0);
      expect(
        await page
          .locator("#cursor")
          .evaluate((element) => Reflect.get(element.style, "opacity")),
      ).toBe("1");
    } finally {
      await page.close();
    }
  });

  test("zooms into a focused rectangle and changes frame on time", async () => {
    const page = await openPage();
    try {
      const focused = await renderAt(page, 300);
      expect(focused.frame).toBe("frame-00001.jpg");
      expect(focused.camera.zoom).toBeGreaterThan(1);
      const red = await page.screenshot({ type: "png" });
      expect(
        await countPixels(
          red,
          (value, green, blue) => value > 200 && green < 80 && blue < 80,
        ),
      ).toBeGreaterThan(0);

      const changed = await renderAt(page, 1100);
      expect(changed.frame).toBe("frame-00002.jpg");
      const blue = await page.screenshot({ type: "png" });
      expect(
        await countPixels(
          blue,
          (redValue, green, value) =>
            value > 100 && redValue < 80 && green < 80,
        ),
      ).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
