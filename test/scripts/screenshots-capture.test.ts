import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import sharp from "sharp";
import {
  browserLaunchOptions,
  launchScreenshotChromium,
} from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
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

  test("builds launch options with only provided fields", () => {
    expect(browserLaunchOptions(true, undefined, undefined)).toEqual({
      headless: true,
    });
    expect(browserLaunchOptions(false, "/usr/bin/ch", ["--flag"])).toEqual({
      args: ["--flag"],
      executablePath: "/usr/bin/ch",
      headless: false,
    });
  });

  test("launches Chromium with screenshot-mode headless and CDP fix", async () => {
    const calls: Parameters<
      Parameters<typeof launchScreenshotChromium>[0]["launch"]
    >[0] = {
      args: ["--disable-features=CDPScreenshotNewSurface"],
      headless: true,
    };
    const fakeBrowser = {
      launch: (options: typeof calls) => Promise.resolve(options),
    };
    const options = await launchScreenshotChromium(
      fakeBrowser as never,
      "/path/to/chromium",
    );

    expect(options).toEqual({
      args: ["--disable-features=CDPScreenshotNewSurface"],
      executablePath: "/path/to/chromium",
      headless: true,
    });
  });

  test("resolves Chromium from the CHROMIUM_EXECUTABLE env var", async () => {
    const envStub = stub(Deno.env, "get", (key) =>
      key === "CHROMIUM_EXECUTABLE" ? "/custom/chromium" : undefined,
    );
    try {
      expect(await chromiumExecutable()).toBe("/custom/chromium");
    } finally {
      envStub.restore();
    }
  });

  test("falls back to the Nix profile path when the env var is unset", async () => {
    const nixEnv = stub(Deno.env, "get", () => undefined);
    const statOk = stub(Deno, "stat", () =>
      Promise.resolve({} as Deno.FileInfo),
    );
    try {
      expect(await chromiumExecutable()).toBe(
        "/etc/profiles/per-user/user/bin/chromium",
      );
    } finally {
      nixEnv.restore();
      statOk.restore();
    }
  });

  test("returns undefined when no env var and the Nix path is absent", async () => {
    const missingEnv = stub(Deno.env, "get", () => undefined);
    const statStub = stub(Deno, "stat", () =>
      Promise.reject(new Deno.errors.NotFound()),
    );
    try {
      expect(await chromiumExecutable()).toBeUndefined();
    } finally {
      missingEnv.restore();
      statStub.restore();
    }
  });

  test("rethrows non-NotFound filesystem errors from the Nix path check", async () => {
    const permEnv = stub(Deno.env, "get", () => undefined);
    const permStub = stub(Deno, "stat", () =>
      Promise.reject(new Deno.errors.PermissionDenied("no access")),
    );
    try {
      await expect(chromiumExecutable()).rejects.toThrow("no access");
    } finally {
      permEnv.restore();
      permStub.restore();
    }
  });
});
