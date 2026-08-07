import type { Page } from "playwright";
import { parseRgb, type Rgb } from "./color.ts";
import {
  cropElementLayerPng,
  elementTrimBounds,
  trimElementPng,
} from "./image.ts";
import {
  SCREENSHOT_LAYER_NAMES,
  type ScreenshotLayerName,
  withScreenshotLayer,
  withWholeOpacityGroups,
} from "./layers.ts";

export interface PreparedScreenshot {
  background: Rgb;
  png: Uint8Array;
}

type CaptureArguments = readonly [
  page: Page,
  elementSelector?: string,
  fullPage?: boolean,
];

type CaptureFunction<Result> = (...args: CaptureArguments) => Promise<Result>;

interface CaptureContext {
  background: Rgb;
  elementSelector: string | undefined;
  fullPage: boolean;
  page: Page;
}

const readBodyBackground = async (page: Page): Promise<Rgb> =>
  parseRgb(
    await page.locator("body").evaluate((node) => {
      const getStyle = Reflect.get(globalThis, "getComputedStyle");
      const style = Reflect.apply(getStyle, globalThis, [node]);
      if (typeof style !== "object" || style === null) {
        throw new Error("Could not read the page style.");
      }
      return String(Reflect.get(style, "backgroundColor"));
    }),
  );

const pagePng = async (
  page: Page,
  fullPage: boolean,
  omitBackground = false,
): Promise<Uint8Array> =>
  new Uint8Array(
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage,
      ...(omitBackground ? { omitBackground } : {}),
      type: "png",
    }),
  );

const prepareCapture = async (
  page: Page,
  elementSelector: string | undefined,
  fullPage: boolean,
): Promise<{ background: Rgb; fullPage: boolean }> => ({
  background: await readBodyBackground(page),
  fullPage: elementSelector ? true : fullPage,
});

const withPreparedCapture =
  <Result>(
    capture: (context: CaptureContext) => Promise<Result>,
  ): CaptureFunction<Result> =>
  async (...[page, elementSelector, fullPage = false]) =>
    capture({
      ...(await prepareCapture(page, elementSelector, fullPage)),
      elementSelector,
      page,
    });

export const capturePreparedLayers: CaptureFunction<
  Record<ScreenshotLayerName, Uint8Array>
> = withPreparedCapture(({ background, elementSelector, fullPage, page }) =>
  withWholeOpacityGroups(page, async () => {
    const normal = await pagePng(page, fullPage);
    const bounds = elementSelector
      ? await elementTrimBounds(normal, background)
      : undefined;
    const entries: [ScreenshotLayerName, Uint8Array][] = [];
    const transparent = { alpha: 0, b: 0, g: 0, r: 0 } as const;
    const paddingByLayer: Record<
      ScreenshotLayerName,
      Rgb & { alpha?: number }
    > = { background, controls: transparent, text: transparent };
    for (const layer of SCREENSHOT_LAYER_NAMES) {
      const png = await withScreenshotLayer(layer)(page, () =>
        pagePng(page, fullPage, true),
      );
      entries.push([
        layer,
        bounds
          ? await cropElementLayerPng(png, bounds, paddingByLayer[layer])
          : png,
      ]);
    }
    return Object.fromEntries(entries) as Record<
      ScreenshotLayerName,
      Uint8Array
    >;
  }),
);

export const capturePreparedPage: CaptureFunction<PreparedScreenshot> =
  withPreparedCapture(
    async ({ background, elementSelector, fullPage, page }) => {
      if (!elementSelector) {
        return {
          background,
          png: await pagePng(page, fullPage),
        };
      }
      const element = page.locator(elementSelector).first();
      await element.waitFor({ state: "attached" });
      const initialBox = await element.boundingBox();
      if (!initialBox) {
        throw new Error(
          `Could not measure screenshot element: ${elementSelector}`,
        );
      }
      await element.evaluate((node) =>
        Reflect.apply(Reflect.get(node, "scrollIntoView"), node, [
          { block: "center" },
        ]),
      );
      return {
        background,
        png: await trimElementPng(await pagePng(page, fullPage), background),
      };
    },
  );
