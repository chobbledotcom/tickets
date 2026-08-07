import type { Page } from "playwright";

export const SCREENSHOT_LAYER_NAMES = [
  "background",
  "controls",
  "text",
] as const;
export type ScreenshotLayerName = (typeof SCREENSHOT_LAYER_NAMES)[number];

const CONTROL_SELECTOR =
  'input, select, textarea, button, [role="button"], a.button, a[class*="button"]';
const CONTROL_LETTERING_SELECTOR =
  'input, textarea, button, [role="button"], a.button, a[class*="button"]';

const LAYER_STYLES: Record<ScreenshotLayerName, string> = {
  background: `
    body *, body *::before, body *::after {
      color: transparent !important;
      text-shadow: none !important;
      -webkit-text-fill-color: transparent !important;
    }
    :is(${CONTROL_SELECTOR}) { visibility: hidden !important; }
    svg text { visibility: hidden !important; }
    *::placeholder { color: transparent !important; }
  `,
  controls: `
    html, body { background: transparent !important; }
    body :not(#__screenshot_layer_mask__) { visibility: hidden !important; }
    :is(${CONTROL_SELECTOR}):not(#__screenshot_layer_mask__):not(#__screenshot_layer_control__),
    :is(${CONTROL_SELECTOR}):not(#__screenshot_layer_mask__):not(#__screenshot_layer_control__) * {
      visibility: visible !important;
    }
    :is(${CONTROL_LETTERING_SELECTOR}), :is(${CONTROL_LETTERING_SELECTOR}) * {
      color: transparent !important;
      text-shadow: none !important;
      -webkit-text-fill-color: transparent !important;
    }
  `,
  text: `
    html, body, body * {
      background: transparent !important;
      border-color: transparent !important;
      box-shadow: none !important;
      outline-color: transparent !important;
    }
    img, picture, video, canvas, svg { visibility: hidden !important; }
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
