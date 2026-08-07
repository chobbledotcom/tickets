import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import {
  capturePreparedLayers,
  capturePreparedPage,
} from "#scripts/screenshots/capture.ts";
import { SCREENSHOT_LAYER_NAMES } from "#scripts/screenshots/layers.ts";
import {
  blankWhitePng,
  whitePngWithBlackBox,
} from "#test/scripts/screenshots-fixture.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

interface CaptureMockConfig {
  bodyStyle?: unknown;
  elementBox?: { width: number; height: number; x: number; y: number } | null;
  screenshot?: (options: { omitBackground?: boolean }) => Promise<Uint8Array>;
}

interface CaptureMockCalls {
  locatorSelectors: string[];
  screenshotOptions: {
    animations?: string;
    fullPage: boolean;
    omitBackground?: boolean;
  }[];
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
        evaluate: (fn: (node: unknown) => unknown) => {
          calls.styleRemovals += 1;
          return Promise.resolve(
            fn({ parentNode: { removeChild: () => undefined } }),
          );
        },
      }),
    clock: {
      pauseAt: () => Promise.resolve(),
      resume: () => Promise.resolve(),
    },
    evaluate: (fn: (argument: never) => unknown, argument: never) =>
      Promise.resolve(fn(argument)),
    locator: (selector: string) => {
      calls.locatorSelectors.push(selector);
      return selector === "body"
        ? {
            evaluate: (fn: (node: unknown) => unknown) =>
              Promise.resolve(fn({ style: bodyStyle(config) })),
          }
        : elementLocator;
    },
    route: (
      _url: string,
      handler: (route: { fulfill: () => Promise<void> }) => Promise<void>,
    ) => handler({ fulfill: () => Promise.resolve() }),
    screenshot: async (opts: {
      animations?: string;
      fullPage: boolean;
      omitBackground?: boolean;
    }) => {
      calls.screenshotOptions.push(opts);
      return await (config.screenshot ?? blankWhitePng)(opts);
    },
    unroute: () => Promise.resolve(),
    url: () => "https://tickets.test/page",
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
  globals.set("__setLayerCaptureFrozen", () => {});
  globals.set("ShadowRoot", class {});
  globals.set("getComputedStyle", (node: { style: unknown }) => node.style);
  const makeElement = (
    opacity: string,
    parentElement: { closest: () => unknown } | null,
  ) => {
    const attributes = new Set<string>();
    return {
      attributes,
      closest: () => null,
      getRootNode: () => document,
      hasAttribute: (attribute: string) => attributes.has(attribute),
      matches: () => false,
      parentElement,
      removeAttribute: (attribute: string) => attributes.delete(attribute),
      setAttribute: (attribute: string) => attributes.add(attribute),
      shadowRoot: null,
      style: {
        backgroundClip: "border-box",
        content: "none",
        display: "block",
        filter: "none",
        getPropertyValue: (name: string) =>
          name === "-webkit-mask-image" ? "none" : "border-box",
        maskImage: "none",
        mixBlendMode: "normal",
        opacity,
        visibility: "visible",
      },
    };
  };
  const opaque = makeElement("1", null);
  const translucent = makeElement("0.5", null);
  const nested = makeElement("0.5", translucent);
  const elements = [opaque, translucent, nested];
  globals.set("document", {
    querySelectorAll: (selector: string) => (selector === "*" ? elements : []),
  });
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
    const { calls, page } = buildCaptureMockPage({});

    const result = await capturePreparedLayers(page);

    expect(Object.keys(result.layers)).toEqual([...SCREENSHOT_LAYER_NAMES]);
    expect(result.background).toEqual({ b: 255, g: 255, r: 255 });
    expect(result.png).toEqual(await blankWhitePng());
    expect(
      calls.screenshotOptions.map(({ omitBackground }) => omitBackground),
    ).toEqual([
      undefined,
      ...SCREENSHOT_LAYER_NAMES.map((layer) =>
        layer === "background" ? undefined : true,
      ),
    ]);
    expect(calls.screenshotOptions.map(({ animations }) => animations)).toEqual(
      Array.from(
        { length: SCREENSHOT_LAYER_NAMES.length + 1 },
        () => undefined,
      ),
    );
    expect(calls.styleRemovals).toBe(SCREENSHOT_LAYER_NAMES.length + 1);
  });

  test("uses one element crop for every layer", async () => {
    const { calls, page } = elementPage();

    const result = await capturePreparedLayers(page, "#element");

    expect(calls.screenshotOptions.every(({ fullPage }) => fullPage)).toBe(
      true,
    );
    expect(calls.styleRemovals).toBe(SCREENSHOT_LAYER_NAMES.length + 1);
    for (const png of Object.values(result.layers)) {
      expect(await sharp(png).metadata()).toEqual(
        expect.objectContaining({ height: 84, width: 94 }),
      );
    }
    const corners = await Promise.all(
      Object.values(result.layers).map(async (png) => [
        ...(await sharp(png)
          .ensureAlpha()
          .extract({ height: 1, left: 0, top: 0, width: 1 })
          .raw()
          .toBuffer()),
      ]),
    );
    expect(corners).toEqual([
      [255, 255, 255, 255],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
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
    expect(calls.styleRemovals).toBe(2);
  });

  test("fails when capture controls were not installed before navigation", async () => {
    globals.set("__setLayerCaptureFrozen", undefined);
    const { page } = buildCaptureMockPage({});

    await expect(capturePreparedLayers(page)).rejects.toThrow(
      "Layer capture was not installed before navigation.",
    );
  });
});
