import type { Page } from "playwright";
import { withCleanup } from "#scripts/cleanup.ts";
import { addScreenshotStyle } from "#scripts/screenshots/style.ts";

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
    :is(html, body)${BACKGROUND_PRIORITY}::before,
    :is(html, body)${BACKGROUND_PRIORITY}::after,
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
    html${LAYER_PRIORITY}, body${LAYER_PRIORITY} { background: transparent !important; }
    :is(html, body)${LAYER_PRIORITY}::before,
    :is(html, body)${LAYER_PRIORITY}::after,
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
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY}::selection,
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} *::selection {
      background-color: transparent !important;
    }
    :is(${CONTROL_SELECTOR})${LAYER_PRIORITY} svg text${LAYER_PRIORITY} {
      visibility: hidden !important;
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
    :is(html, body)${TEXT_CHROME_PRIORITY}::before,
    :is(html, body)${TEXT_CHROME_PRIORITY}::after,
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

const withTemporaryPageChange = async <T>(
  start: () => Promise<() => Promise<void>>,
  run: () => Promise<T>,
): Promise<T> => withCleanup(run, [await start()]);

type PageChange = <T>(page: Page, run: () => Promise<T>) => Promise<T>;

const definePageChange =
  <Config>(
    start: (config: Config, page: Page) => Promise<() => Promise<void>>,
  ) =>
  (config: Config): PageChange =>
  (page, run) =>
    withTemporaryPageChange(() => start(config, page), run);

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
      const containingControl = (element: Element): Element | null => {
        let current: Element | null = element;
        while (current) {
          if (current.matches(controlSelector)) return current;
          current = parentOf(current);
        }
        return null;
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
        style.mixBlendMode !== "normal" ||
        style.content.includes("url(") ||
        [
          style.getPropertyValue("backdrop-filter"),
          style.getPropertyValue("-webkit-backdrop-filter"),
          style.getPropertyValue("clip-path"),
          style.getPropertyValue("-webkit-clip-path"),
        ].some((value) => value !== "" && value !== "none") ||
        [style.maskImage, style.getPropertyValue("-webkit-mask-image")].some(
          (value) => value !== "none",
        );
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
        if (containingControl(element)) {
          element.setAttribute(visibleControl, "");
        }
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
        if (styles.some(isWholePaint)) {
          (containingControl(element) ?? element).setAttribute(wholePaint, "");
        }
      };

      const markRootText = (root: Document | ShadowRoot): void => {
        const containers: ParentNode[] =
          root === document
            ? [document.documentElement, document.body]
            : [root];
        if (
          containers.some((container) =>
            [...container.childNodes].some(
              (node) =>
                node.nodeType === 3 && Boolean(node.textContent?.trim()),
            ),
          )
        ) {
          (root instanceof ShadowRoot ? root.host : document.body).setAttribute(
            wholePaint,
            "",
          );
        }
      };
      const markTopLayer = (root: Document | ShadowRoot): void => {
        if (
          root.querySelectorAll(":is(dialog:modal, [popover]:popover-open)")
            .length > 0
        ) {
          document.documentElement.setAttribute(wholePaint, "");
        }
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

      const paintMark = (element: Element): string | null => {
        const ownMark = [textPaint, wholePaint].find((attribute) =>
          element.hasAttribute(attribute),
        );
        const parent = parentOf(element);
        return ownMark ?? (parent ? paintMark(parent) : null);
      };
      const markInheritedPaint = (
        element: Element,
        inheritedPaint: string | null,
      ): void => {
        if (!inheritedPaint || element.parentElement) return;
        element.setAttribute(inheritedPaint, "");
      };

      function visitRoot(
        root: Document | ShadowRoot,
        inheritedPaint: string | null = null,
      ): void {
        if (add) {
          markRootText(root);
          markTopLayer(root);
        }
        for (const element of root.querySelectorAll("*")) {
          markInheritedPaint(element, inheritedPaint);
          changeElement(element);
          if (element.shadowRoot) {
            visitRoot(element.shadowRoot, paintMark(element) ?? inheritedPaint);
          }
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

export const withScreenshotLayerStyle: (
  layer: ScreenshotLayerName,
) => PageChange = definePageChange<ScreenshotLayerName>((layer, page) =>
  addScreenshotStyle(page, LAYER_STYLES[layer]),
);
