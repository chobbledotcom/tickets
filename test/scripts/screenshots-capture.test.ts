import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import sharp from "sharp";
import {
  browserLaunchOptions,
  launchScreenshotChromium,
} from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import {
  capturePreparedPage,
  readBodyBackground,
} from "#scripts/screenshots/capture.ts";
import { trimElementPng } from "#scripts/screenshots/image.ts";
import {
  MOBILE_SCREENSHOT_PROFILE,
  screenshotContextOptions,
} from "#scripts/screenshots/profile.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

const blankWhitePng = async (): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
      create: {
        background: { alpha: 1, b: 255, g: 255, r: 255 },
        channels: 4,
        height: 50,
        width: 50,
      },
    })
      .png()
      .toBuffer(),
  );

// A white page with a 30x20 black box at (35, 40) — the fixture
// trimElementPng trims down to 94x84 (box + 32 pixels of padding each side).
const whitePngWithBlackBox = async (): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp({
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
      .toBuffer(),
  );

interface CaptureMockConfig {
  bodyBackground?: string;
  elementBox?: { width: number; height: number; x: number; y: number } | null;
  initialViewport?: { width: number; height: number } | null;
  screenshot?: () => Promise<Uint8Array>;
}

interface CaptureMockCalls {
  locatorSelectors: string[];
  resizes: { width: number; height: number }[];
  screenshotOptions: { fullPage: boolean }[];
  scrollFns: number;
}

// Builds the smallest Page-shaped mock needed by capturePreparedPage; each
// method records its calls so tests can assert the capture flow without
// launching a real browser or Playwright. The body locator returns the
// mock background colour directly (its inner fn is covered by the
// readBodyBackground tests below).
const buildCaptureMockPage = (
  config: CaptureMockConfig,
): { calls: CaptureMockCalls; page: never } => {
  const calls: CaptureMockCalls = {
    locatorSelectors: [],
    resizes: [],
    screenshotOptions: [],
    scrollFns: 0,
  };
  const elementLocator = {
    boundingBox: () => Promise.resolve(config.elementBox ?? null),
    evaluate: (fn: (node: unknown) => unknown) => {
      // Invoke the fn synchronously with a stub node so its body is covered
      // in the test isolate too (Playwright normally runs it in the browser).
      calls.scrollFns += 1;
      return Promise.resolve(fn({ scrollIntoView: () => {} }));
    },
    first: () => elementLocator,
    waitFor: () => Promise.resolve(),
  };
  const page = {
    locator: (selector: string) => {
      calls.locatorSelectors.push(selector);
      return selector === "body"
        ? {
            evaluate: () =>
              Promise.resolve(config.bodyBackground ?? "rgb(255, 255, 255)"),
          }
        : elementLocator;
    },
    screenshot: async (opts: { fullPage: boolean }) => {
      calls.screenshotOptions.push(opts);
      return await (config.screenshot ?? blankWhitePng)();
    },
    setViewportSize: async (size: { width: number; height: number }) => {
      calls.resizes.push(size);
    },
    viewportSize: () => config.initialViewport ?? null,
  };
  return { calls, page: page as never };
};

// Shared default mock-page config for capturePreparedPage's element path:
// white body, a 30x20 box at (35, 40) — the same fixture the trimElementPng
// tests use — and a 390x100 viewport that is grown to 148 when the box
// exceeds it. `overrides` swap the parts each test varies (viewport,
// screenshot, element box) so the element-path tests share one setup.
const buildStandardElementPage = async (
  overrides: Partial<CaptureMockConfig> = {},
): Promise<{ calls: CaptureMockCalls; page: never }> =>
  buildCaptureMockPage({
    bodyBackground: "rgb(255, 255, 255)",
    elementBox: { height: 20, width: 30, x: 35, y: 40 },
    initialViewport: { height: 100, width: 390 },
    screenshot: () => whitePngWithBlackBox(),
    ...overrides,
  });

const rejectedScreenshot: () => Promise<Uint8Array> = () =>
  Promise.reject(new Error("should not screenshot"));

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
    const result = await trimElementPng(await whitePngWithBlackBox(), {
      b: 255,
      g: 255,
      r: 255,
    });

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

describe("readBodyBackground", () => {
  // The inner fn of `evaluate` runs in the browser via Playwright's
  // serialization; here we invoke it synchronously so its body is covered in
  // the test isolate too. The stash installs a fake `getComputedStyle` on
  // globalThis for the duration of each test and removes it on cleanup.
  let stash: ReturnType<typeof createGlobalStash>;
  beforeEach(() => {
    stash = createGlobalStash();
  });
  afterEach(() => {
    stash.restore();
  });

  test("parses the body background colour returned by the browser", async () => {
    stash.set("getComputedStyle", () => ({
      backgroundColor: "rgb(255, 255, 255)",
    }));

    const colour = await readBodyBackground({
      locator: () => ({
        evaluate: (fn: (node: unknown) => unknown) => Promise.resolve(fn({})),
      }),
    } as never);

    expect(colour).toEqual({ b: 255, g: 255, r: 255 });
  });

  test("throws when computed style returns no style object", async () => {
    stash.set("getComputedStyle", () => null);

    await expect(
      readBodyBackground({
        locator: () => ({
          evaluate: (fn: (node: unknown) => unknown) => Promise.resolve(fn({})),
        }),
      } as never),
    ).rejects.toThrow("Could not read the page style.");
  });
});

describe("capturePreparedPage", () => {
  test("returns the body background and the screenshot when no element is selected", async () => {
    const screenshot = await blankWhitePng();
    const { calls, page } = buildCaptureMockPage({
      bodyBackground: "rgb(255, 255, 255)",
      screenshot: () => Promise.resolve(screenshot),
    });

    const result = await capturePreparedPage(page);

    expect(result.background).toEqual({ b: 255, g: 255, r: 255 });
    expect(result.png).toEqual(screenshot);
    expect(calls.screenshotOptions).toEqual([
      {
        animations: "disabled",
        caret: "hide",
        fullPage: false,
        type: "png",
      },
    ]);
    expect(calls.resizes).toEqual([]);
  });

  test("passes fullPage: true through to the screenshot", async () => {
    const { calls, page } = buildCaptureMockPage({
      bodyBackground: "rgb(0, 0, 0)",
    });

    await capturePreparedPage(page, undefined, true);

    expect(calls.screenshotOptions[0]?.fullPage).toBe(true);
  });

  test("captures, scrolls, and trims the element with the viewport grown", async () => {
    const { calls, page } = await buildStandardElementPage();

    const result = await capturePreparedPage(page, "#element");

    expect(calls.locatorSelectors).toEqual(["body", "#element"]);
    expect(calls.scrollFns).toBe(1);
    expect(calls.resizes).toEqual([
      { height: 148, width: 390 },
      { height: 100, width: 390 },
    ]);
    expect(await sharp(result.png).metadata()).toEqual(
      expect.objectContaining({ format: "png", height: 84, width: 94 }),
    );
  });

  test("keeps the original viewport when it already fits the element plus padding", async () => {
    const { calls, page } = await buildStandardElementPage({
      initialViewport: { height: 500, width: 390 },
    });

    await capturePreparedPage(page, "#element");

    expect(calls.resizes).toEqual([
      { height: 500, width: 390 },
      { height: 500, width: 390 },
    ]);
  });

  test("throws when the page has no viewport size", async () => {
    const { calls, page } = await buildStandardElementPage({
      initialViewport: null,
      screenshot: rejectedScreenshot,
    });

    await expect(capturePreparedPage(page, "#element")).rejects.toThrow(
      "Could not read the screenshot viewport.",
    );
    expect(calls.resizes).toEqual([]);
    expect(calls.screenshotOptions).toEqual([]);
  });

  test("throws when the element has no bounding box", async () => {
    const { calls, page } = await buildStandardElementPage({
      elementBox: null,
      screenshot: rejectedScreenshot,
    });

    await expect(capturePreparedPage(page, "#element")).rejects.toThrow(
      "Could not measure screenshot element: #element",
    );
    expect(calls.resizes).toEqual([]);
    expect(calls.screenshotOptions).toEqual([]);
  });

  test("restores the original viewport even when the screenshot fails", async () => {
    const { calls, page } = await buildStandardElementPage({
      screenshot: () => Promise.reject(new Error("playwright blew up")),
    });

    await expect(capturePreparedPage(page, "#element")).rejects.toThrow(
      "playwright blew up",
    );

    expect(calls.resizes).toEqual([
      { height: 148, width: 390 },
      { height: 100, width: 390 },
    ]);
  });
});
