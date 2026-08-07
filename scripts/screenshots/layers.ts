import type { Page } from "playwright";

export const SCREENSHOT_LAYER_NAMES = [
  "background",
  "controls",
  "text",
] as const;
export type ScreenshotLayerName = (typeof SCREENSHOT_LAYER_NAMES)[number];

const CONTROL_SELECTOR =
  'input, select, textarea, button, [role="button"], a.btn, a.button, a[class*="button"]';
const LAYER_PRIORITY =
  ":not(#__screenshot_layer_mask__):not(#__screenshot_layer_control__)";

const LAYER_STYLES: Record<ScreenshotLayerName, string> = {
  background: `
    body ${LAYER_PRIORITY}, body ${LAYER_PRIORITY}::before, body ${LAYER_PRIORITY}::after {
      color: transparent !important;
      text-decoration-color: transparent !important;
      text-shadow: none !important;
      -webkit-text-fill-color: transparent !important;
      -webkit-text-stroke-color: transparent !important;
    }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY},
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} * { visibility: hidden !important; }
    svg text${LAYER_PRIORITY} { visibility: hidden !important; }
    body ${LAYER_PRIORITY}::placeholder { color: transparent !important; }
  `,
  controls: `
    html, body { background: transparent !important; }
    body ${LAYER_PRIORITY} { visibility: hidden !important; }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY},
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} * {
      visibility: visible !important;
    }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY},
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} * {
      color: transparent !important;
      text-decoration-color: transparent !important;
      text-shadow: none !important;
      -webkit-text-fill-color: transparent !important;
      -webkit-text-stroke-color: transparent !important;
    }
  `,
  text: `
    html, body, body ${LAYER_PRIORITY}, body ${LAYER_PRIORITY}::before, body ${LAYER_PRIORITY}::after {
      background: transparent !important;
      border-color: transparent !important;
      box-shadow: none !important;
      outline-color: transparent !important;
    }
    :is(img, picture, video, canvas)${LAYER_PRIORITY},
    svg :is(path, circle, ellipse, line, polygon, polyline, rect, image, use, foreignObject)${LAYER_PRIORITY} {
      visibility: hidden !important;
    }
  `,
};

export const withScreenshotLayer = async <T>(
  page: Page,
  layer: ScreenshotLayerName,
  capture: () => Promise<T>,
): Promise<T> => {
  const style = await page.addStyleTag({ content: LAYER_STYLES[layer] });
  try {
    return await capture();
  } finally {
    await style.evaluate((node) => node.parentNode?.removeChild(node));
  }
};
