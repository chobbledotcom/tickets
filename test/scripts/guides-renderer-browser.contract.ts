import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser, Page } from "playwright";
import sharp from "sharp";
import { withStrictBrowserTimeouts } from "#scripts/browser-options.ts";
import { startGuideRenderServer } from "#scripts/guides/render/server.ts";
import { focusEvent, guideTimeline, pointerEvent } from "./guides-fixtures.ts";
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

type PixelTest = (red: number, green: number, blue: number) => boolean;

const countPixels = async (
  png: Uint8Array,
  wanted: PixelTest,
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

const timeline = guideTimeline(
  2000,
  [
    pointerEvent("cursor", 0, 100, 100),
    focusEvent(200, { height: 100, width: 200, x: 100, y: 100 }, 0.5, 200),
    pointerEvent("click", 400, 100, 100),
    { atMs: 1000, kind: "blur", transitionMs: 200 },
  ],
  1000,
);

const isRed: PixelTest = (red, green, blue) =>
  red > 200 && green < 80 && blue < 80;

const isBlue: PixelTest = (red, green, blue) =>
  blue > 100 && red < 80 && green < 80;

/** Expects the page to show at least one pixel that passes the test. */
const expectPixelShown = async (page: Page, wanted: PixelTest) => {
  const png = await page.screenshot({ type: "png" });
  expect(await countPixels(png, wanted)).toBeGreaterThan(0);
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

  const withRendererPage = async (
    run: (page: Page) => Promise<void>,
  ): Promise<void> => {
    const page = await openPage();
    try {
      await run(page);
    } finally {
      await page.close();
    }
  };

  /** Renders one moment and expects its frame file and a pixel colour. */
  const showsFrame = async (
    page: Page,
    atMs: number,
    file: string,
    wanted: PixelTest,
  ): Promise<RenderResult> => {
    const result = await renderAt(page, atMs);
    expect(result.frame).toBe(file);
    await expectPixelShown(page, wanted);
    return result;
  };

  test("shows the first frame and hides nothing before a focus", () =>
    withRendererPage(async (page) => {
      const result = await showsFrame(page, 0, "frame-00001.jpg", isRed);
      expect(result.camera.zoom).toBe(1);
      expect(
        await page
          .locator("#cursor")
          .evaluate((element) => Reflect.get(element.style, "opacity")),
      ).toBe("1");
    }));

  test("zooms into a focused rectangle and changes frame on time", () =>
    withRendererPage(async (page) => {
      const focused = await showsFrame(page, 300, "frame-00001.jpg", isRed);
      expect(focused.camera.zoom).toBeGreaterThan(1);
      await showsFrame(page, 1100, "frame-00002.jpg", isBlue);
    }));
});
