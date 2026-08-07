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
  frozen = false,
): Promise<Uint8Array> =>
  new Uint8Array(
    await page.screenshot({
      ...(frozen ? {} : { animations: "disabled" as const }),
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

const runAndResumeClock = async <Result>(
  page: Page,
  run: () => Promise<Result>,
): Promise<Result> => {
  const setFrozen = (frozen: boolean): Promise<void> =>
    page.evaluate((value) => {
      const setLayerCaptureFrozen = Reflect.get(
        globalThis,
        "__setLayerCaptureFrozen",
      );
      if (typeof setLayerCaptureFrozen !== "function") {
        throw new Error("Layer capture was not installed before navigation.");
      }
      Reflect.apply(setLayerCaptureFrozen, globalThis, [value]);
    }, frozen);
  await setFrozen(true);
  try {
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    return await run();
  } finally {
    await page.clock.resume();
    await setFrozen(false);
  }
};

export const installLayerCaptureClock = async (page: Page): Promise<void> => {
  await page.clock.install();
  await page.addInitScript(() => {
    let frozen = false;
    const waiting: (() => void)[] = [];
    const runOrWait = (run: () => void, wait: boolean): void => {
      if (!frozen) run();
      else if (wait) waiting.push(run);
    };
    const wrap = (callback: unknown, wait: boolean): unknown =>
      typeof callback === "function"
        ? (...args: unknown[]) =>
            runOrWait(() => Reflect.apply(callback, globalThis, args), wait)
        : callback;
    const nativeMethod = (name: string): ((args: unknown[]) => unknown) => {
      const method = Reflect.get(globalThis, name);
      if (typeof method !== "function") {
        throw new Error(`Missing browser method: ${name}`);
      }
      return (args) => Reflect.apply(method, globalThis, args);
    };
    const nativeSetInterval = nativeMethod("setInterval");
    const nativeSetTimeout = nativeMethod("setTimeout");
    const nativeRequestAnimationFrame = nativeMethod("requestAnimationFrame");
    const installTimer = (
      name: string,
      nativeTimer: (args: unknown[]) => unknown,
      wait: boolean,
    ): void => {
      Reflect.set(
        globalThis,
        name,
        (callback: unknown, delay: number, ...args: unknown[]) =>
          nativeTimer([wrap(callback, wait), delay, ...args]),
      );
    };
    installTimer("setInterval", nativeSetInterval, false);
    installTimer("setTimeout", nativeSetTimeout, true);
    Reflect.set(
      globalThis,
      "requestAnimationFrame",
      (callback: (time: number) => void) =>
        nativeRequestAnimationFrame([
          (time: number) => runOrWait(() => callback(time), false),
        ]),
    );
    Reflect.set(globalThis, "__setLayerCaptureFrozen", (value: boolean) => {
      frozen = value;
      if (frozen) return;
      for (const run of waiting.splice(0)) queueMicrotask(run);
    });
  });
};

const captureLayers = async (
  page: Page,
  elementSelector: string | undefined,
  fullPage: boolean,
  background: Rgb,
): Promise<Record<ScreenshotLayerName, Uint8Array>> => {
  const normal = await pagePng(page, fullPage, false, true);
  const bounds = elementSelector
    ? await elementTrimBounds(normal, background)
    : undefined;
  const entries: [ScreenshotLayerName, Uint8Array][] = [];
  const transparent = { alpha: 0, b: 0, g: 0, r: 0 } as const;
  const paddingByLayer: Record<ScreenshotLayerName, Rgb & { alpha?: number }> =
    {
      background,
      controls: transparent,
      text: transparent,
    };
  for (const layer of SCREENSHOT_LAYER_NAMES) {
    const png = await withScreenshotLayer(layer)(page, () =>
      pagePng(page, fullPage, layer !== "background", true),
    );
    entries.push([
      layer,
      bounds
        ? await cropElementLayerPng(png, bounds, paddingByLayer[layer])
        : png,
    ]);
  }
  return Object.fromEntries(entries) as Record<ScreenshotLayerName, Uint8Array>;
};

export const capturePreparedLayers: CaptureFunction<
  Record<ScreenshotLayerName, Uint8Array>
> = withPreparedCapture(({ background, elementSelector, fullPage, page }) =>
  runAndResumeClock(page, () =>
    captureLayers(page, elementSelector, fullPage, background),
  ),
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
