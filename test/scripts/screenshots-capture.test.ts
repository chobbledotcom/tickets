import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import {
  capturePreparedLayers,
  capturePreparedPage,
  installLayerCaptureClock,
} from "#scripts/screenshots/capture.ts";
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
        getPropertyValue: () => "border-box",
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
    querySelectorAll: (selector: string) =>
      selector === "html, body, body *" || selector === "*"
        ? elements
        : selector.startsWith("link[")
          ? []
          : elements.filter(({ attributes }) => attributes.size > 0),
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

    expect(Object.keys(result)).toEqual(["background", "controls", "text"]);
    expect(
      calls.screenshotOptions.map(({ omitBackground }) => omitBackground),
    ).toEqual([undefined, undefined, true, true]);
    expect(calls.styleRemovals).toBe(3);
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
    const corners = await Promise.all(
      Object.values(result).map(async (png) => [
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
    expect(calls.styleRemovals).toBe(1);
  });

  test("fails when capture controls were not installed before navigation", async () => {
    globals.set("__setLayerCaptureFrozen", undefined);
    const { page } = buildCaptureMockPage({});

    await expect(capturePreparedLayers(page)).rejects.toThrow(
      "Layer capture was not installed before navigation.",
    );
  });
});

describe("installLayerCaptureClock", () => {
  test("holds page callbacks while layer captures are frozen", async () => {
    let intervalCallback: unknown;
    let timeoutCallback: unknown;
    let frameCallback: unknown;
    const nativeCalls: unknown[][] = [];
    globals.set("setInterval", (callback: unknown, ...args: unknown[]) => {
      intervalCallback = callback;
      nativeCalls.push(["interval", ...args]);
      return 1;
    });
    globals.set("setTimeout", (callback: unknown, ...args: unknown[]) => {
      timeoutCallback = callback;
      nativeCalls.push(["timeout", callback, ...args]);
      return 2;
    });
    globals.set("requestAnimationFrame", (callback: unknown) => {
      frameCallback = callback;
      return 3;
    });
    let installs = 0;
    const page = {
      addInitScript: (script: () => void) => {
        script();
        return Promise.resolve();
      },
      clock: {
        install: () => {
          installs += 1;
          return Promise.resolve();
        },
      },
    } as never;

    await installLayerCaptureClock(page);
    expect(installs).toBe(1);

    const intervalRuns: unknown[] = [];
    setInterval((value) => intervalRuns.push(value), 10, "ready");
    if (typeof intervalCallback !== "function") {
      throw new Error("Interval callback was not installed.");
    }
    Reflect.apply(intervalCallback, globalThis, ["ready"]);
    expect(intervalRuns).toEqual(["ready"]);

    Reflect.apply(Reflect.get(globalThis, "setTimeout"), globalThis, [
      "literal callback",
      5,
    ]);
    expect(nativeCalls.at(-1)).toEqual(["timeout", "literal callback", 5]);

    const setFrozen = Reflect.get(globalThis, "__setLayerCaptureFrozen");
    if (typeof setFrozen !== "function") {
      throw new Error("Layer capture controls were not installed.");
    }
    Reflect.apply(setFrozen, globalThis, [true]);

    let timeoutRuns = 0;
    setTimeout(() => {
      timeoutRuns += 1;
    }, 20);
    if (typeof timeoutCallback !== "function") {
      throw new Error("Timeout callback was not installed.");
    }
    Reflect.apply(timeoutCallback, globalThis, []);
    Reflect.apply(intervalCallback, globalThis, ["frozen"]);

    let frameTime = 0;
    requestAnimationFrame((time) => {
      frameTime = time;
    });
    if (typeof frameCallback !== "function") {
      throw new Error("Animation frame callback was not installed.");
    }
    Reflect.apply(frameCallback, globalThis, [25]);
    expect(intervalRuns).toEqual(["ready"]);
    expect(timeoutRuns).toBe(0);
    expect(frameTime).toBe(0);

    Reflect.apply(setFrozen, globalThis, [false]);
    await Promise.resolve();
    expect(timeoutRuns).toBe(1);

    requestAnimationFrame((time) => {
      frameTime = time;
    });
    if (typeof frameCallback !== "function") {
      throw new Error("Animation frame callback was not installed.");
    }
    Reflect.apply(frameCallback, globalThis, [50]);
    expect(frameTime).toBe(50);
  });

  test("fails when the browser has no animation frame method", async () => {
    globals.set("requestAnimationFrame", undefined);
    const page = {
      addInitScript: (script: () => void) => Promise.resolve(script()),
      clock: { install: () => Promise.resolve() },
    } as never;

    await expect(installLayerCaptureClock(page)).rejects.toThrow(
      "Missing browser method: requestAnimationFrame",
    );
  });
});
