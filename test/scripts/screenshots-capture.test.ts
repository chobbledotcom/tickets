import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import {
  capturePreparedLayers,
  capturePreparedPage,
} from "#scripts/screenshots/capture.ts";
import {
  blankWhitePng,
  whitePngWithBlackBox,
} from "#test/scripts/screenshots-fixture.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

interface CaptureMockConfig {
  bodyStyle?: unknown;
  detachedStyle?: boolean;
  elementBox?: { width: number; height: number; x: number; y: number } | null;
  screenshot?: (options: { omitBackground?: boolean }) => Promise<Uint8Array>;
}

interface CaptureMockCalls {
  locatorSelectors: string[];
  screenshotOptions: { fullPage: boolean; omitBackground?: boolean }[];
  scrollFns: number;
  styleRemovals: number;
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
    styleRemovals: 0,
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
    addStyleTag: () =>
      Promise.resolve({
        evaluate: (fn: (node: unknown) => unknown) =>
          Promise.resolve(
            fn({
              parentNode: config.detachedStyle
                ? null
                : {
                    removeChild: () => {
                      calls.styleRemovals += 1;
                    },
                  },
            }),
          ),
      }),
    locator: (selector: string) => {
      calls.locatorSelectors.push(selector);
      return selector === "body"
        ? {
            evaluate: (fn: (node: unknown) => unknown) =>
              Promise.resolve(fn({ style: bodyStyle(config) })),
          }
        : elementLocator;
    },
    screenshot: async (opts: {
      fullPage: boolean;
      omitBackground?: boolean;
    }) => {
      calls.screenshotOptions.push(opts);
      return await (config.screenshot ?? blankWhitePng)(opts);
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

const globals = createGlobalStash();

beforeEach(() => {
  globals.set("getComputedStyle", (node: { style: unknown }) => node.style);
});

afterEach(() => globals.restore());

describe("capturePreparedPage", () => {
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

describe("capturePreparedLayers", () => {
  test("captures transparent background, control and text layers", async () => {
    const { calls, page } = buildCaptureMockPage({ detachedStyle: true });

    const result = await capturePreparedLayers(page);

    expect(Object.keys(result)).toEqual(["background", "controls", "text"]);
    expect(
      calls.screenshotOptions.map(({ omitBackground }) => omitBackground),
    ).toEqual([undefined, true, true, true]);
    expect(calls.styleRemovals).toBe(0);
  });

  test("uses one element crop for every layer", async () => {
    const { calls, page } = elementPage();

    const result = await capturePreparedLayers(page, "#element");

    expect(calls.screenshotOptions.every(({ fullPage }) => fullPage)).toBe(
      true,
    );
    expect(calls.styleRemovals).toBe(3);
    for (const png of Object.values(result)) {
      expect(await sharp(png).metadata()).toEqual(
        expect.objectContaining({ height: 84, width: 94 }),
      );
    }
  });

  test("removes the layer style when capture fails", async () => {
    let screenshots = 0;
    const { calls, page } = buildCaptureMockPage({
      screenshot: async () => {
        screenshots += 1;
        if (screenshots === 2) throw new Error("layer capture failed");
        return await blankWhitePng();
      },
    });

    await expect(capturePreparedLayers(page)).rejects.toThrow(
      "layer capture failed",
    );
    expect(calls.styleRemovals).toBe(1);
  });
});
