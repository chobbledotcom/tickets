import type { Page } from "playwright";

export const SCREENSHOT_LAYER_NAMES = [
  "background",
  "controls",
  "text",
] as const;
export type ScreenshotLayerName = (typeof SCREENSHOT_LAYER_NAMES)[number];

const SCREENSHOT_LAYER = "__screenshot_layer__";
const WHOLE_OPACITY_ATTRIBUTE = "data-screenshot-whole-opacity";
const CONTROL_SELECTOR =
  'input, select, textarea, button, summary, label:has(input), [role="button"], [role="option"], .btn, a.button, a[class*="button"]';
const LAYER_PRIORITY =
  ":not(#__screenshot_layer_mask__):not(#__screenshot_layer_control__)";
const BACKGROUND_PRIORITY = `${LAYER_PRIORITY}:not([${WHOLE_OPACITY_ATTRIBUTE}]):not([${WHOLE_OPACITY_ATTRIBUTE}] ${LAYER_PRIORITY})`;
const HIDDEN_TEXT_STYLE = `
  text-decoration-color: transparent !important;
  text-shadow: none !important;
  -webkit-text-fill-color: transparent !important;
  -webkit-text-stroke-color: transparent !important;
`;

const LAYER_STYLES: Record<ScreenshotLayerName, string> = {
  background: `@layer ${SCREENSHOT_LAYER} {
    body ${BACKGROUND_PRIORITY}, body ${BACKGROUND_PRIORITY}::before, body ${BACKGROUND_PRIORITY}::after {
      ${HIDDEN_TEXT_STYLE}
    }
    :is(${CONTROL_SELECTOR})${BACKGROUND_PRIORITY},
    :is(${CONTROL_SELECTOR})${BACKGROUND_PRIORITY} * { visibility: hidden !important; }
    svg text${BACKGROUND_PRIORITY} { visibility: hidden !important; }
    body ${BACKGROUND_PRIORITY}::placeholder {
      color: transparent !important;
      ${HIDDEN_TEXT_STYLE}
    }
  }`,
  controls: `@layer ${SCREENSHOT_LAYER} {
    html, body { background: transparent !important; }
    body ${LAYER_PRIORITY} { visibility: hidden !important; }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY},
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} * {
      visibility: visible !important;
    }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY},
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} *,
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY}::before,
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY}::after,
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} *::before,
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} *::after {
      ${HIDDEN_TEXT_STYLE}
    }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY}::placeholder {
      color: transparent !important;
      ${HIDDEN_TEXT_STYLE}
    }
    [${WHOLE_OPACITY_ATTRIBUTE}]${LAYER_PRIORITY},
    [${WHOLE_OPACITY_ATTRIBUTE}]${LAYER_PRIORITY} * { visibility: hidden !important; }
  }`,
  text: `@layer ${SCREENSHOT_LAYER} {
    html, body, body ${LAYER_PRIORITY}, body ${LAYER_PRIORITY}::before, body ${LAYER_PRIORITY}::after,
    dialog${LAYER_PRIORITY}::backdrop {
      background: transparent !important;
      border-color: transparent !important;
      box-shadow: none !important;
      outline-color: transparent !important;
    }
    :is(input[type="checkbox"], input[type="radio"])${LAYER_PRIORITY} {
      visibility: hidden !important;
    }
    :is(input:not([type="checkbox"]):not([type="radio"]), select, textarea)${LAYER_PRIORITY} {
      appearance: none !important;
    }
    input[type="file"]${LAYER_PRIORITY}::file-selector-button {
      background: transparent !important;
      border-color: transparent !important;
      box-shadow: none !important;
      outline-color: transparent !important;
    }
    input${LAYER_PRIORITY}::-webkit-calendar-picker-indicator { visibility: hidden !important; }
    :is(img, picture, video, canvas, iframe, object, embed)${LAYER_PRIORITY},
    svg :is(path, circle, ellipse, line, polygon, polyline, rect, image, use)${LAYER_PRIORITY} {
      visibility: hidden !important;
    }
    [${WHOLE_OPACITY_ATTRIBUTE}]${LAYER_PRIORITY},
    [${WHOLE_OPACITY_ATTRIBUTE}]${LAYER_PRIORITY} * { visibility: hidden !important; }
  }`,
};

const runAndCleanUp = async <T>(
  run: () => Promise<T>,
  cleanUp: () => Promise<void>,
): Promise<T> => {
  try {
    return await run();
  } finally {
    await cleanUp();
  }
};

const withTemporaryPageChange = async <T>(
  start: () => Promise<() => Promise<void>>,
  run: () => Promise<T>,
): Promise<T> => runAndCleanUp(run, await start());

type PageChange = <T>(page: Page, run: () => Promise<T>) => Promise<T>;

const definePageChange =
  <Config>(
    start: (config: Config, page: Page) => Promise<() => Promise<void>>,
  ) =>
  (config: Config): PageChange =>
  (page, run) =>
    withTemporaryPageChange(() => start(config, page), run);

export const addScreenshotStyle = async (
  page: Page,
  css: string,
): Promise<() => Promise<void>> => {
  const marker = crypto.randomUUID();
  const url = new URL("/custom.css", page.url());
  url.searchParams.set("screenshot-style", marker);
  const href = url.toString();
  await page.route(href, (route) =>
    route.fulfill({ body: css, contentType: "text/css" }),
  );
  const style = await page.addStyleTag({ url: href });
  return async () => {
    await style.evaluate((node) => node.parentNode?.removeChild(node));
    await page.unroute(href);
  };
};

const defineWholeOpacityGroups = definePageChange<void>(
  async (_config, page) => {
    await page.evaluate((attribute) => {
      const marked = `[${attribute}]`;
      for (const element of document.querySelectorAll("html, body, body *")) {
        if (
          getComputedStyle(element).opacity !== "1" &&
          !element.parentElement?.closest(marked)
        ) {
          element.setAttribute(attribute, "");
        }
      }
    }, WHOLE_OPACITY_ATTRIBUTE);
    return () =>
      page.evaluate((attribute) => {
        for (const element of document.querySelectorAll(`[${attribute}]`)) {
          element.removeAttribute(attribute);
        }
      }, WHOLE_OPACITY_ATTRIBUTE);
  },
);

export const withWholeOpacityGroups: PageChange = defineWholeOpacityGroups();

export const withScreenshotLayer: (layer: ScreenshotLayerName) => PageChange =
  definePageChange<ScreenshotLayerName>((layer, page) =>
    addScreenshotStyle(page, LAYER_STYLES[layer]),
  );
