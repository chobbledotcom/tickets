interface ScreenshotPageReadiness {
  evaluate(expression: string): Promise<unknown>;
  waitForFunction(expression: string): Promise<unknown>;
  waitForLoadState(state: "load"): Promise<unknown>;
}

const FONTS_READY = 'document.fonts.status === "loaded"';
const TWO_PAINTS = `new Promise((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(resolve)))`;

export const waitForScreenshotPage = async (
  page: ScreenshotPageReadiness,
): Promise<void> => {
  await page.waitForLoadState("load");
  await page.waitForFunction(FONTS_READY);
  await page.evaluate(TWO_PAINTS);
};
