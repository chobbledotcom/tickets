import { Buffer } from "node:buffer";
import { expect } from "@std/expect";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import sharp from "sharp";
import { defineScreenshotBrowserLauncher } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import {
  capturePreparedLayers,
  installLayerCaptureClock,
} from "#scripts/screenshots/capture.ts";
import {
  SCREENSHOT_LAYER_NAMES,
  type ScreenshotLayerName,
  withScreenshotLayerStyle,
  withWholePaintGroups,
} from "#scripts/screenshots/layers.ts";

export const withLayer = <T>(
  page: Page,
  layer: ScreenshotLayerName,
  run: () => Promise<T>,
): Promise<T> =>
  withWholePaintGroups(page, () => withScreenshotLayerStyle(layer)(page, run));

export const launchScreenshotBrowser: () => Promise<Browser> =
  defineScreenshotBrowserLauncher(chromium, chromiumExecutable);
export const launchScreenshotBrowserWithScrollbars: () => Promise<Browser> =
  defineScreenshotBrowserLauncher(chromium, chromiumExecutable, {
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });

export const countRgbPixels = async (
  png: Uint8Array,
  [wantedRed, wantedGreen, wantedBlue]: readonly [number, number, number],
): Promise<number> => {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data.reduce(
    (count, red, index) =>
      index % info.channels === 0 &&
      red === wantedRed &&
      data[index + 1] === wantedGreen &&
      data[index + 2] === wantedBlue &&
      data[index + 3] !== 0
        ? count + 1
        : count,
    0,
  );
};

export const expectOnlyLayerColor = async (
  layers: Record<ScreenshotLayerName, Uint8Array>,
  color: readonly [number, number, number],
  wantedLayer: ScreenshotLayerName,
): Promise<void> => {
  for (const layer of SCREENSHOT_LAYER_NAMES) {
    const count = await countRgbPixels(layers[layer], color);
    if (layer === wantedLayer) expect(count).toBeGreaterThan(0);
    else expect(count).toBe(0);
  }
};

export const countLayerRgbPixels =
  (
    page: Page,
    selector: string,
    color: readonly [number, number, number],
  ): ((layer: ScreenshotLayerName) => Promise<number>) =>
  async (layer) =>
    countRgbPixels(
      await withLayer(page, layer, () =>
        page.locator(selector).screenshot({ omitBackground: true }),
      ),
      color,
    );

export const expectLayersRecombine = async (
  page: Page,
  label: string,
): Promise<void> => {
  const { layers, png: normal } = await capturePreparedLayers(page);
  const metadata = await sharp(normal).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Could not measure the screenshot.");
  }
  const combined = await sharp({
    create: {
      background: "white",
      channels: 4,
      height: metadata.height,
      width: metadata.width,
    },
  })
    .composite([
      { input: Buffer.from(layers.background) },
      { input: Buffer.from(layers.controls) },
      { input: Buffer.from(layers.text) },
    ])
    .raw()
    .toBuffer();
  expect(combined, `${label} should recombine exactly`).toEqual(
    await sharp(normal).ensureAlpha().raw().toBuffer(),
  );
};

export const layerStyle = (
  page: Page,
  layer: ScreenshotLayerName,
  selector: string,
  property: string,
  pseudo?: string,
): Promise<string> =>
  withLayer(page, layer, () =>
    page
      .locator(selector)
      .evaluate(
        (element, options) =>
          getComputedStyle(element, options.pseudo).getPropertyValue(
            options.property,
          ),
        { property, pseudo },
      ),
  );

export const withPage = async (
  browser: Browser,
  content: string,
  check: (page: Page) => Promise<void>,
): Promise<void> => {
  const page = await browser.newPage();
  try {
    await installLayerCaptureClock(page);
    const url = `https://screenshots.test/${crypto.randomUUID()}`;
    await page.route(url, (route) =>
      route.fulfill({ body: content, contentType: "text/html" }),
    );
    await page.goto(url);
    await check(page);
  } finally {
    await page.close();
  }
};
