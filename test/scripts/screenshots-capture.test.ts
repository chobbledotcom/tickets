import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import { capturePreparedPage } from "#scripts/screenshots/capture.ts";
import {
  blankWhitePng,
  whitePngWithBlackBox,
} from "#test/scripts/screenshots-fixture.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

interface CaptureMockConfig {
  bodyStyle?: unknown;
  elementBox?: { width: number; height: number; x: number; y: number } | null;
  screenshot?: () => Promise<Uint8Array>;
}

interface CaptureMockCalls {
  locatorSelectors: string[];
  screenshotOptions: { fullPage: boolean }[];
  scrollFns: number;
}

const bodyStyle = (config: CaptureMockConfig): unknown =>
  Object.hasOwn(config, "bodyStyle")
    ? config.bodyStyle
    : { backgroundColor: "rgb(255, 255, 255)" };

const buildCaptureMockPage = (
  config: CaptureMockConfig,
): { calls: CaptureMockCalls; page: never } => {
  const calls: CaptureMockCalls = {
    locatorSelectors: [],
    screenshotOptions: [],
    scrollFns: 0,
  };
  const elementLocator = {
    boundingBox: () => Promise.resolve(config.elementBox ?? null),
    evaluate: (fn: (node: unknown) => unknown) => {
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
            evaluate: (fn: (node: unknown) => unknown) =>
              Promise.resolve(fn({ style: bodyStyle(config) })),
          }
        : elementLocator;
    },
    screenshot: async (opts: { fullPage: boolean }) => {
      calls.screenshotOptions.push(opts);
      return await (config.screenshot ?? blankWhitePng)();
    },
  };
  return { calls, page: page as never };
};

const elementPage = (
  overrides: Partial<CaptureMockConfig> = {},
): { calls: CaptureMockCalls; page: never } =>
  buildCaptureMockPage({
    elementBox: { height: 20, width: 30, x: 35, y: 40 },
    screenshot: whitePngWithBlackBox,
    ...overrides,
  });

describe("capturePreparedPage", () => {
  let globals: ReturnType<typeof createGlobalStash>;

  beforeEach(() => {
    globals = createGlobalStash();
    globals.set("getComputedStyle", (node: { style: unknown }) => node.style);
  });

  afterEach(() => globals.restore());

  test("returns the body background and viewport screenshot", async () => {
    const screenshot = await blankWhitePng();
    const { calls, page } = buildCaptureMockPage({
      screenshot: () => Promise.resolve(screenshot),
    });

    const result = await capturePreparedPage(page);

    expect(result).toEqual({
      background: { b: 255, g: 255, r: 255 },
      png: screenshot,
    });
    expect(calls.screenshotOptions).toEqual([
      {
        animations: "disabled",
        caret: "hide",
        fullPage: false,
        type: "png",
      },
    ]);
  });

  test("passes fullPage through for a whole-page capture", async () => {
    const { calls, page } = buildCaptureMockPage({});

    await capturePreparedPage(page, undefined, true);

    expect(calls.screenshotOptions[0]?.fullPage).toBe(true);
  });

  test("captures and trims the whole page without changing its viewport", async () => {
    const { calls, page } = elementPage();

    const result = await capturePreparedPage(page, "#element");

    expect(calls.locatorSelectors).toEqual(["body", "#element"]);
    expect(calls.scrollFns).toBe(1);
    expect(calls.screenshotOptions[0]?.fullPage).toBe(true);
    expect(await sharp(result.png).metadata()).toEqual(
      expect.objectContaining({ format: "png", height: 84, width: 94 }),
    );
  });

  test("throws when the element has no bounding box", async () => {
    const { calls, page } = elementPage({ elementBox: null });

    await expect(capturePreparedPage(page, "#element")).rejects.toThrow(
      "Could not measure screenshot element: #element",
    );
    expect(calls.screenshotOptions).toEqual([]);
  });

  test("propagates screenshot failures", async () => {
    const { page } = elementPage({
      screenshot: () => Promise.reject(new Error("playwright blew up")),
    });

    await expect(capturePreparedPage(page, "#element")).rejects.toThrow(
      "playwright blew up",
    );
  });

  test("throws when computed style returns no style object", async () => {
    const { page } = buildCaptureMockPage({ bodyStyle: null });

    await expect(capturePreparedPage(page)).rejects.toThrow(
      "Could not read the page style.",
    );
  });
});
