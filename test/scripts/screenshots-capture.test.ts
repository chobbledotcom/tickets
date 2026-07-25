import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import { trimElementPng } from "#scripts/screenshots/image.ts";
import {
  MOBILE_SCREENSHOT_PROFILE,
  screenshotContextOptions,
} from "#scripts/screenshots/profile.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";

describe("reusable screenshot capture", () => {
  test("waits for fonts and two browser paints", async () => {
    const calls: string[] = [];
    await waitForScreenshotPage({
      evaluate: (expression) => {
        calls.push(expression);
        return Promise.resolve();
      },
      waitForFunction: (expression) => {
        calls.push(expression);
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      'document.fonts.status === "loaded"',
      `new Promise((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    ]);
  });

  test("uses the deterministic mobile browser profile", () => {
    expect(screenshotContextOptions(MOBILE_SCREENSHOT_PROFILE)).toEqual({
      colorScheme: "light",
      deviceScaleFactor: 2,
      locale: "en-GB",
      reducedMotion: "reduce",
      timezoneId: "UTC",
      viewport: { height: 844, width: 390 },
    });
  });

  test("trims an element and adds the established 32 pixel padding", async () => {
    const source = await sharp({
      create: {
        background: { alpha: 1, b: 255, g: 255, r: 255 },
        channels: 4,
        height: 100,
        width: 100,
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              background: { alpha: 1, b: 0, g: 0, r: 0 },
              channels: 4,
              height: 20,
              width: 30,
            },
          })
            .png()
            .toBuffer(),
          left: 35,
          top: 40,
        },
      ])
      .png()
      .toBuffer();

    const result = await trimElementPng(source, { b: 255, g: 255, r: 255 });

    expect(await sharp(result).metadata()).toEqual(
      expect.objectContaining({ format: "png", height: 84, width: 94 }),
    );
  });

  test("rejects an element image whose background was not trimmed", async () => {
    const source = await sharp({
      create: {
        background: "black",
        channels: 3,
        height: 10,
        width: 10,
      },
    })
      .png()
      .toBuffer();

    await expect(
      trimElementPng(source, { b: 255, g: 255, r: 255 }),
    ).rejects.toThrow("has no visible content");
  });
});
