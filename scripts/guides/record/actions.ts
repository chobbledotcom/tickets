/**
 * One action vocabulary, used twice: the setup list drives the site before the
 * camera rolls, and the story list drives it on camera. The same code proves
 * the two cannot disagree about a selector.
 */

import type { Locator, Page } from "playwright";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";
import type { GuideAction } from "../storyboard.ts";
import type { GuideRect, GuideTimelineEvent } from "../timeline.ts";

const CURSOR_MOVE_MS = 300;
const DEFAULT_PER_CHARACTER_MS = 70;
const DEFAULT_FOCUS_SCALE = 0.72;
const DEFAULT_FOCUS_TRANSITION_MS = 900;
const DEFAULT_SCROLL_SETTLE_MS = 120;
const DEFAULT_SCROLL_STEPS = 6;

export interface ActionRecorder {
  cursor: { x: number; y: number };
  events: GuideTimelineEvent[];
  muted: boolean;
  now: () => number;
  viewport: { height: number; width: number };
}

const record = (recorder: ActionRecorder, event: GuideTimelineEvent): void => {
  if (!recorder.muted) recorder.events.push(event);
};

const recordCursor = (
  recorder: ActionRecorder,
  point: { x: number; y: number },
): void => {
  record(recorder, {
    atMs: recorder.now(),
    kind: "cursor",
    x: point.x,
    y: point.y,
  });
};

const pageViewport = (page: Page): { height: number; width: number } => {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The guide page has no viewport");
  return viewport;
};

const clampBox = (
  box: GuideRect,
  viewport: { height: number; width: number },
): GuideRect => {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const width = Math.min(box.width, viewport.width - x);
  const height = Math.min(box.height, viewport.height - y);
  if (width <= 0 || height <= 0) {
    throw new Error("A guide target fell outside the viewport");
  }
  return { height, width, x, y };
};

const visibleBox = async (
  page: Page,
  selector: string,
): Promise<{ height: number; width: number; x: number; y: number }> => {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible" });
  const viewport = pageViewport(page);
  const before = await locator.boundingBox();
  if (!before) throw new Error(`Could not measure guide selector ${selector}`);
  const alreadyInView =
    before.y >= 0 && before.y + before.height <= viewport.height;
  if (!alreadyInView) {
    await locator.evaluate((element) =>
      Reflect.apply(Reflect.get(element, "scrollIntoView"), element, [
        { behavior: "smooth", block: "center" },
      ]),
    );
    await page.waitForTimeout(500);
  } else {
    await page.waitForTimeout(120);
  }
  return clampBox((await locator.boundingBox()) ?? before, viewport);
};

const movePointer = async (
  page: Page,
  recorder: ActionRecorder,
  point: { x: number; y: number },
): Promise<void> => {
  recordCursor(recorder, recorder.cursor);
  await page.mouse.move(point.x, point.y, { steps: 1 });
  await page.waitForTimeout(CURSOR_MOVE_MS);
  recordCursor(recorder, point);
  recorder.cursor = point;
};

const clickSelector = async (
  page: Page,
  recorder: ActionRecorder,
  selector: string,
  options: { navigate?: boolean } = {},
): Promise<void> => {
  const box = await visibleBox(page, selector);
  const point = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
  await movePointer(page, recorder, point);
  record(recorder, {
    atMs: recorder.now(),
    kind: "click",
    x: point.x,
    y: point.y,
  });
  if (options.navigate !== false) {
    await page.locator(selector).first().click();
  }
};

/** Every field action starts the same way: point at the field, click it, run
 * the change, and let the browser paint the result. */
const withClickedField = async <T>(
  page: Page,
  recorder: ActionRecorder,
  selector: string,
  run: (field: Locator) => Promise<T>,
): Promise<T> => {
  await clickSelector(page, recorder, selector);
  const result = await run(page.locator(selector).first());
  await page.waitForTimeout(180);
  return result;
};

export const executeGuideAction = async (
  page: Page,
  action: GuideAction,
  recorder: ActionRecorder,
): Promise<void> => {
  switch (action.kind) {
    case "open": {
      await page.goto(action.path, { waitUntil: "domcontentloaded" });
      await waitForScreenshotPage(page);
      await page.waitForTimeout(250);
      return;
    }
    case "click": {
      await clickSelector(page, recorder, action.selector);
      await page.waitForTimeout(250);
      return;
    }
    case "openLink": {
      const href = await page
        .locator(action.selector)
        .first()
        .getAttribute("href");
      if (!href) {
        throw new Error(`Guide link ${action.selector} has no address`);
      }
      await clickSelector(page, recorder, action.selector, { navigate: false });
      const path = new URL(href, page.url());
      await page.goto(`${path.pathname}${path.search}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForScreenshotPage(page);
      await page.waitForTimeout(300);
      return;
    }
    case "type": {
      await withClickedField(page, recorder, action.selector, async (field) => {
        await field.fill("");
        await field.pressSequentially(action.text, {
          delay: action.perCharacterMs ?? DEFAULT_PER_CHARACTER_MS,
        });
      });
      return;
    }
    case "fill":
    case "select":
    case "check": {
      await withClickedField(page, recorder, action.selector, async (field) => {
        if (action.kind === "fill") await field.fill(action.value);
        else if (action.kind === "select") {
          await field.selectOption(action.value);
        } else await field.check();
      });
      return;
    }
    case "scroll": {
      const steps = action.steps ?? DEFAULT_SCROLL_STEPS;
      const settleMs = action.settleMs ?? DEFAULT_SCROLL_SETTLE_MS;
      for (let step = 0; step < steps; step += 1) {
        await page.mouse.wheel(0, action.deltaY / steps);
        await page.waitForTimeout(settleMs);
      }
      return;
    }
    case "focus": {
      const box = await visibleBox(page, action.selector);
      record(recorder, {
        atMs: recorder.now(),
        kind: "focus",
        rect: clampBox(box, pageViewport(page)),
        scale: action.scale ?? DEFAULT_FOCUS_SCALE,
        transitionMs: action.transitionMs ?? DEFAULT_FOCUS_TRANSITION_MS,
      });
      return;
    }
    case "blur": {
      record(recorder, {
        atMs: recorder.now(),
        kind: "blur",
        transitionMs: action.transitionMs ?? DEFAULT_FOCUS_TRANSITION_MS,
      });
      await page.waitForTimeout(
        (action.transitionMs ?? DEFAULT_FOCUS_TRANSITION_MS) + 100,
      );
      return;
    }
    case "wait": {
      await page.waitForTimeout(action.ms);
      return;
    }
    case "evidence": {
      record(recorder, {
        atMs: recorder.now(),
        captureId: action.captureId,
        kind: "evidence",
      });
      await page.waitForTimeout(300);
      return;
    }
  }
};

export const executeGuideActions = async (
  page: Page,
  actions: readonly GuideAction[],
  recorder: ActionRecorder,
): Promise<void> => {
  for (const [index, action] of actions.entries()) {
    try {
      await executeGuideAction(page, action, recorder);
    } catch (error) {
      throw new Error(
        `Guide action ${index + 1} (${action.kind}) failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
};
