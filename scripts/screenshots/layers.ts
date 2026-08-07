import type { Page } from "playwright";

export const SCREENSHOT_LAYER_NAMES = [
  "background",
  "controls",
  "text",
] as const;
export type ScreenshotLayerName = (typeof SCREENSHOT_LAYER_NAMES)[number];

const SCREENSHOT_LAYER = "__screenshot_layer__";
const WHOLE_PAINT_ATTRIBUTE = "data-screenshot-whole-paint";
const TEXT_PAINT_ATTRIBUTE = "data-screenshot-text-paint";
const VISIBLE_CONTROL_ATTRIBUTE = "data-screenshot-visible-control";
const CONTROL_SELECTOR =
  'input, select, textarea, button, summary, label:has(input), label[for], [role="button"], [role="option"], .btn, a.button, a[class*="button"]';
const LAYER_PRIORITY =
  ":not(#__screenshot_layer_mask__):not(#__screenshot_layer_control__)";
const BACKGROUND_PRIORITY = `${LAYER_PRIORITY}:not([${WHOLE_PAINT_ATTRIBUTE}]):not([${WHOLE_PAINT_ATTRIBUTE}] ${LAYER_PRIORITY}):not([${TEXT_PAINT_ATTRIBUTE}]):not([${TEXT_PAINT_ATTRIBUTE}] ${LAYER_PRIORITY})`;
const TEXT_CHROME_PRIORITY = `${LAYER_PRIORITY}:not([${TEXT_PAINT_ATTRIBUTE}]):not([${TEXT_PAINT_ATTRIBUTE}] ${LAYER_PRIORITY})`;
const WHOLE_PAINT_PRIORITY = `[${WHOLE_PAINT_ATTRIBUTE}][${WHOLE_PAINT_ATTRIBUTE}]${LAYER_PRIORITY}`;
const TEXT_PAINT_PRIORITY = `[${TEXT_PAINT_ATTRIBUTE}][${TEXT_PAINT_ATTRIBUTE}]${LAYER_PRIORITY}`;
const VISIBLE_CONTROL_PRIORITY = `[${VISIBLE_CONTROL_ATTRIBUTE}][${VISIBLE_CONTROL_ATTRIBUTE}]${LAYER_PRIORITY}`;
const HIDDEN_TEXT_STYLE = `
  text-decoration-color: transparent !important;
  text-shadow: none !important;
  -webkit-text-fill-color: transparent !important;
  -webkit-text-stroke-color: transparent !important;
`;

const LAYER_STYLES: Record<ScreenshotLayerName, string> = {
  background: `@layer ${SCREENSHOT_LAYER} {
    body${BACKGROUND_PRIORITY}::before, body${BACKGROUND_PRIORITY}::after,
    :is(body, :host) ${BACKGROUND_PRIORITY},
    :is(body, :host) ${BACKGROUND_PRIORITY}::before,
    :is(body, :host) ${BACKGROUND_PRIORITY}::after {
      ${HIDDEN_TEXT_STYLE}
    }
    :is(${CONTROL_SELECTOR})${BACKGROUND_PRIORITY},
    :is(${CONTROL_SELECTOR})${BACKGROUND_PRIORITY} * { visibility: hidden !important; }
    svg text${BACKGROUND_PRIORITY} { visibility: hidden !important; }
    :is(body, :host) ${BACKGROUND_PRIORITY}::placeholder {
      color: transparent !important;
      ${HIDDEN_TEXT_STYLE}
    }
    ${TEXT_PAINT_PRIORITY}, ${TEXT_PAINT_PRIORITY} *,
    :host([${TEXT_PAINT_ATTRIBUTE}]), :host([${TEXT_PAINT_ATTRIBUTE}]) * {
      visibility: hidden !important;
    }
  }`,
  controls: `@layer ${SCREENSHOT_LAYER} {
    html, body { background: transparent !important; }
    body${LAYER_PRIORITY}::before, body${LAYER_PRIORITY}::after,
    :is(body, :host) ${LAYER_PRIORITY} { visibility: hidden !important; }
    ${VISIBLE_CONTROL_PRIORITY} {
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
    ${WHOLE_PAINT_PRIORITY},
    ${WHOLE_PAINT_PRIORITY} *,
    ${TEXT_PAINT_PRIORITY},
    ${TEXT_PAINT_PRIORITY} *,
    :host([${WHOLE_PAINT_ATTRIBUTE}]), :host([${WHOLE_PAINT_ATTRIBUTE}]) *,
    :host([${TEXT_PAINT_ATTRIBUTE}]), :host([${TEXT_PAINT_ATTRIBUTE}]) * {
      visibility: hidden !important;
    }
  }`,
  text: `@layer ${SCREENSHOT_LAYER} {
    html${TEXT_CHROME_PRIORITY}, body${TEXT_CHROME_PRIORITY},
    body${TEXT_CHROME_PRIORITY}::before, body${TEXT_CHROME_PRIORITY}::after,
    :is(body, :host) ${TEXT_CHROME_PRIORITY},
    :is(body, :host) ${TEXT_CHROME_PRIORITY}::before,
    :is(body, :host) ${TEXT_CHROME_PRIORITY}::after,
    dialog${TEXT_CHROME_PRIORITY}::backdrop {
      background: transparent !important;
      border-color: transparent !important;
      border-image: none !important;
      box-shadow: none !important;
      outline-color: transparent !important;
    }
    :is(input[type="checkbox"], input[type="radio"])${TEXT_CHROME_PRIORITY} {
      visibility: hidden !important;
    }
    :is(input:not([type="checkbox"]):not([type="radio"]), select, textarea)${TEXT_CHROME_PRIORITY} {
      appearance: none !important;
    }
    input[type="file"]${TEXT_CHROME_PRIORITY}::file-selector-button {
      background: transparent !important;
      border-color: transparent !important;
      box-shadow: none !important;
      outline-color: transparent !important;
    }
    input${TEXT_CHROME_PRIORITY}::-webkit-calendar-picker-indicator { visibility: hidden !important; }
    summary${TEXT_CHROME_PRIORITY}::marker,
    summary${TEXT_CHROME_PRIORITY}::-webkit-details-marker { color: transparent !important; }
    :is(body, :host) ${TEXT_CHROME_PRIORITY}::-webkit-scrollbar,
    :is(body, :host) ${TEXT_CHROME_PRIORITY}::-webkit-scrollbar-button,
    :is(body, :host) ${TEXT_CHROME_PRIORITY}::-webkit-scrollbar-corner,
    :is(body, :host) ${TEXT_CHROME_PRIORITY}::-webkit-scrollbar-resizer,
    :is(body, :host) ${TEXT_CHROME_PRIORITY}::-webkit-scrollbar-thumb,
    :is(body, :host) ${TEXT_CHROME_PRIORITY}::-webkit-scrollbar-track,
    :is(body, :host) ${TEXT_CHROME_PRIORITY}::-webkit-scrollbar-track-piece {
      background: transparent !important;
      border-color: transparent !important;
      border-image: none !important;
      box-shadow: none !important;
    }
    :is(img, picture, video, canvas, iframe, object, embed)${TEXT_CHROME_PRIORITY},
    svg :is(path, circle, ellipse, line, polygon, polyline, rect, image, use)${TEXT_CHROME_PRIORITY} {
      visibility: hidden !important;
    }
    ${WHOLE_PAINT_PRIORITY},
    ${WHOLE_PAINT_PRIORITY} *,
    :host([${WHOLE_PAINT_ATTRIBUTE}]), :host([${WHOLE_PAINT_ATTRIBUTE}]) * {
      visibility: hidden !important;
    }
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
  const cleanUp = async (): Promise<void> => {
    await page.evaluate((styleMarker) => {
      const removeFromOpenRoots = (root: Document | ShadowRoot): void => {
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) removeFromOpenRoots(element.shadowRoot);
        }
        for (const link of root.querySelectorAll(
          `link[data-screenshot-style="${styleMarker}"]`,
        )) {
          link.remove();
        }
      };
      removeFromOpenRoots(document);
    }, marker);
    await style.evaluate((node) => node.parentNode?.removeChild(node));
    await page.unroute(href);
  };
  try {
    await page.evaluate(
      async ({ href, marker }) => {
        const addToOpenRoots = async (
          root: Document | ShadowRoot,
        ): Promise<void> => {
          const shadowRoots = Array.from(
            root.querySelectorAll("*"),
            (element) => element.shadowRoot,
          ).filter(
            (shadowRoot): shadowRoot is ShadowRoot => shadowRoot !== null,
          );
          await Promise.all(
            shadowRoots.map(async (shadowRoot) => {
              const link = document.createElement("link");
              link.dataset.screenshotStyle = marker;
              link.rel = "stylesheet";
              link.href = href;
              await new Promise<void>((resolve, reject) => {
                link.addEventListener("load", () => resolve(), { once: true });
                link.addEventListener(
                  "error",
                  () => reject(new Error("Could not load screenshot style.")),
                  { once: true },
                );
                shadowRoot.appendChild(link);
              });
              await addToOpenRoots(shadowRoot);
            }),
          );
        };
        await addToOpenRoots(document);
      },
      { href, marker },
    );
  } catch (error) {
    await cleanUp();
    throw error;
  }
  return cleanUp;
};

const changeLayerMarks = (page: Page, add: boolean): Promise<void> =>
  page.evaluate(
    ({ add, controlSelector, textPaint, visibleControl, wholePaint }) => {
      const attributes = [textPaint, visibleControl, wholePaint];
      const parentOf = (element: Element): Element | null => {
        if (element.parentElement) return element.parentElement;
        const root = element.getRootNode();
        return root instanceof ShadowRoot ? root.host : null;
      };
      const hasMarkedParent = (element: Element): boolean => {
        let parent = parentOf(element);
        while (parent) {
          if (
            parent.hasAttribute(wholePaint) ||
            parent.hasAttribute(textPaint)
          ) {
            return true;
          }
          parent = parentOf(parent);
        }
        return false;
      };
      const insideControl = (element: Element): boolean => {
        let current: Element | null = element;
        while (current) {
          if (current.matches(controlSelector)) return true;
          current = parentOf(current);
        }
        return false;
      };
      const generatedStyle = (
        element: Element,
        pseudo: string,
      ): CSSStyleDeclaration | null => {
        const style = getComputedStyle(element, pseudo);
        return style.content === "none" || style.display === "none"
          ? null
          : style;
      };
      const isWholePaint = (style: CSSStyleDeclaration): boolean =>
        style.opacity !== "1" ||
        style.filter !== "none" ||
        style.mixBlendMode !== "normal";
      const isTextPaint = (style: CSSStyleDeclaration): boolean =>
        [
          style.backgroundClip,
          style.getPropertyValue("-webkit-background-clip"),
        ].some((value) =>
          value.split(",").some((clip) => clip.trim() === "text"),
        );

      const removeMarks = (element: Element): void => {
        for (const attribute of attributes) element.removeAttribute(attribute);
      };
      const markVisibleControl = (
        element: Element,
        style: CSSStyleDeclaration,
      ): void => {
        if (style.visibility !== "visible") return;
        if (insideControl(element)) element.setAttribute(visibleControl, "");
      };
      const paintStyles = (element: Element, style: CSSStyleDeclaration) =>
        [
          style,
          generatedStyle(element, "::before"),
          generatedStyle(element, "::after"),
        ].filter((item): item is CSSStyleDeclaration => item !== null);
      const markPaint = (
        element: Element,
        styles: CSSStyleDeclaration[],
      ): void => {
        if (hasMarkedParent(element)) return;
        if (styles.some(isTextPaint)) {
          element.setAttribute(textPaint, "");
          return;
        }
        if (styles.some(isWholePaint)) element.setAttribute(wholePaint, "");
      };

      function changeElement(element: Element): void {
        if (!add) {
          removeMarks(element);
          return;
        }

        const style = getComputedStyle(element);
        markVisibleControl(element, style);
        markPaint(element, paintStyles(element, style));
      }

      function visitRoot(root: Document | ShadowRoot): void {
        for (const element of root.querySelectorAll("*")) {
          changeElement(element);
          if (element.shadowRoot) visitRoot(element.shadowRoot);
        }
      }
      visitRoot(document);
    },
    {
      add,
      controlSelector: CONTROL_SELECTOR,
      textPaint: TEXT_PAINT_ATTRIBUTE,
      visibleControl: VISIBLE_CONTROL_ATTRIBUTE,
      wholePaint: WHOLE_PAINT_ATTRIBUTE,
    },
  );

const defineWholePaintGroups = definePageChange<void>(async (_config, page) => {
  await changeLayerMarks(page, true);
  return () => changeLayerMarks(page, false);
});

export const withWholePaintGroups: PageChange = defineWholePaintGroups();

const withLayerStyle = definePageChange<ScreenshotLayerName>((layer, page) =>
  addScreenshotStyle(page, LAYER_STYLES[layer]),
);

export const withScreenshotLayer =
  (layer: ScreenshotLayerName): PageChange =>
  (page, run) =>
    withWholePaintGroups(page, () => withLayerStyle(layer)(page, run));
