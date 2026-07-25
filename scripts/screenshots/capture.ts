import type { Page } from "playwright";
import { parseRgb, type Rgb } from "./color.ts";
import { trimElementPng } from "./image.ts";

export interface PreparedScreenshot {
  background: Rgb;
  png: Uint8Array;
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

const pagePng = async (page: Page, fullPage: boolean): Promise<Uint8Array> =>
  new Uint8Array(
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage,
      type: "png",
    }),
  );

export const capturePreparedPage = async (
  page: Page,
  elementSelector?: string,
  fullPage = false,
): Promise<PreparedScreenshot> => {
  const background = await readBodyBackground(page);
  if (!elementSelector) {
    return { background, png: await pagePng(page, fullPage) };
  }
  const element = page.locator(elementSelector).first();
  await element.waitFor({ state: "attached" });
  const initialBox = await element.boundingBox();
  if (!initialBox) {
    throw new Error(`Could not measure screenshot element: ${elementSelector}`);
  }
  await element.evaluate((node) =>
    Reflect.apply(Reflect.get(node, "scrollIntoView"), node, [
      { block: "center" },
    ]),
  );
  return {
    background,
    png: await trimElementPng(await pagePng(page, true), background),
  };
};
