import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { defineScreenshotBrowserLauncher } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import {
  type ScreenshotLayerName,
  withScreenshotLayer,
} from "#scripts/screenshots/layers.ts";

export const launchScreenshotBrowser: () => Promise<Browser> =
  defineScreenshotBrowserLauncher(chromium, chromiumExecutable);

export const layerStyle = (
  page: Page,
  layer: ScreenshotLayerName,
  selector: string,
  property: string,
  pseudo?: string,
): Promise<string> =>
  withScreenshotLayer(page, layer, () =>
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
    await page.setContent(content);
    await check(page);
  } finally {
    await page.close();
  }
};
