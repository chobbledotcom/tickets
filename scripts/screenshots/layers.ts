import type { Page } from "playwright";

export const SCREENSHOT_LAYER_NAMES = [
  "background",
  "controls",
  "text",
] as const;
export type ScreenshotLayerName = (typeof SCREENSHOT_LAYER_NAMES)[number];

const CONTROL_SELECTOR =
  'input, select, textarea, button, summary, label:has(input), [role="button"], .btn, a.button, a[class*="button"]';
const LAYER_PRIORITY =
  ":not(#__screenshot_layer_mask__):not(#__screenshot_layer_control__)";
const HIDDEN_TEXT_STYLE = `
  text-decoration-color: transparent !important;
  text-shadow: none !important;
  -webkit-text-fill-color: transparent !important;
  -webkit-text-stroke-color: transparent !important;
`;

const LAYER_STYLES: Record<ScreenshotLayerName, string> = {
  background: `@layer __screenshot_layer__ {
    body ${LAYER_PRIORITY}, body ${LAYER_PRIORITY}::before, body ${LAYER_PRIORITY}::after {
      ${HIDDEN_TEXT_STYLE}
    }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY},
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} * { visibility: hidden !important; }
    svg text${LAYER_PRIORITY} { visibility: hidden !important; }
    body ${LAYER_PRIORITY}::placeholder {
      color: transparent !important;
      ${HIDDEN_TEXT_STYLE}
    }
  }`,
  controls: `@layer __screenshot_layer__ {
    html, body { background: transparent !important; }
    body ${LAYER_PRIORITY} { visibility: hidden !important; }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY},
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} * {
      visibility: visible !important;
    }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY},
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} *,
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY}::before,
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY}::after {
      ${HIDDEN_TEXT_STYLE}
    }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY}::placeholder {
      color: transparent !important;
      ${HIDDEN_TEXT_STYLE}
    }
  }`,
  text: `@layer __screenshot_layer__ {
    html, body, body ${LAYER_PRIORITY}, body ${LAYER_PRIORITY}::before, body ${LAYER_PRIORITY}::after,
    dialog${LAYER_PRIORITY}::backdrop {
      background: transparent !important;
      border-color: transparent !important;
      box-shadow: none !important;
      outline-color: transparent !important;
    }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} { appearance: none !important; }
    :is(img, picture, video, canvas, iframe, object, embed)${LAYER_PRIORITY},
    svg :is(path, circle, ellipse, line, polygon, polyline, rect, image, use)${LAYER_PRIORITY} {
      visibility: hidden !important;
    }
  }`,
};

export const addScreenshotStyle = async (
  page: Page,
  css: string,
): Promise<() => Promise<void>> => {
  const marker = crypto.randomUUID();
  await page.evaluate(
    ({ css, marker }) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      Reflect.set(sheet, marker, true);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    },
    { css, marker },
  );
  return () =>
    page.evaluate((marker) => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => !Reflect.get(sheet, marker),
      );
    }, marker);
};

export const withScreenshotLayer = async <T>(
  page: Page,
  layer: ScreenshotLayerName,
  capture: () => Promise<T>,
): Promise<T> => {
  const removeStyle = await addScreenshotStyle(page, LAYER_STYLES[layer]);
  try {
    return await capture();
  } finally {
    await removeStyle();
  }
};
