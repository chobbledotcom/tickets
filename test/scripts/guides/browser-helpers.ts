/** Shared browser setup for the guide browser contracts. */
import type { Browser, Page } from "playwright";
import sharp from "sharp";
import { withStrictBrowserTimeouts } from "#scripts/browser-options.ts";
import type { LoopbackServer } from "#scripts/loopback-server.ts";

/** Open a page at `url` with the guide browser's strict limits. */
export const newGuidePage = async (
  browser: Browser,
  viewport: { height: number; width: number },
  url: string,
): Promise<Page> => {
  const page = await browser.newPage({ viewport });
  withStrictBrowserTimeouts(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
};

/** Wait until the renderer page has drawn its first frame. */
export const waitForGuideReady = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => Reflect.get(globalThis, "rendererReady") === true);

/** Close the browser and server, then remove the test directory. */
export const closeGuideBrowser = async (
  browser: Browser,
  server: LoopbackServer,
  directory: string,
): Promise<void> => {
  await browser.close();
  await server.close();
  await Deno.remove(directory, { recursive: true });
};

/** The red channel at the centre of a screenshot. */
export const redAtCentre = async (page: Page): Promise<number> => {
  const png = await page.screenshot({ type: "png" });
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const x = Math.floor(info.width / 2);
  const y = Math.floor(info.height / 2);
  return data[(y * info.width + x) * info.channels]!;
};
