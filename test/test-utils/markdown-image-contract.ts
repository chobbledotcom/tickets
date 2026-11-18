/**
 * Shared page helpers for the image picker's browser contract: the dialog's
 * selectors, its close waits, and the editor typing and focus probes.
 */

import { expect } from "@std/expect";
import type { Locator, Page } from "playwright";

/* jscpd:ignore-start -- a list of strings, not code */
export const EDITOR_BUTTON = ".md-toolbar-image";
export const DIALOG = ".md-image-dialog";
export const OPTION = ".md-image-option";
export const NOTE = ".md-image-note";
export const THUMBNAIL = ".md-image-option img";
export const CONTENT_BOX = 'textarea[name="content"]';
export const EMPTY_MESSAGE = "No images yet.";
export const UNAVAILABLE_MESSAGE = "Images are unavailable right now.";
/* jscpd:ignore-end */

/** Waits for the image dialog to be closed, whatever closed it. */
export const waitForDialogClosed = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    () =>
      (document.querySelector(".md-image-dialog") as HTMLDialogElement)
        ?.open === false,
  );
};

/** Asserts the editor body holds focus again, the way the native dialog
 * close hands it back. */
export const expectFocusBackInEditor = async (page: Page): Promise<void> => {
  expect(
    await page.evaluate(
      () => document.activeElement === document.querySelector(".ProseMirror"),
    ),
  ).toBe(true);
};

/** The grid's and the last option's page boxes, failing loudly when either
 * is missing from the page. */
export const gridAndLastOptionBoxes = async (page: Page, grid: Locator) => {
  const gridBox = await grid.boundingBox();
  const optionBox = await page.locator(OPTION).last().boundingBox();
  if (gridBox === null || optionBox === null) {
    throw new Error("the grid or its last option is not on the page");
  }
  return { gridBox, optionBox };
};

/** Focuses the editor body and types `text`. Start a new line with an
 * explicit Enter where the insertion point must sit below the typed words. */
export const typeIntoEditorBody = async (
  page: Page,
  text: string,
): Promise<void> => {
  const body = page.locator(".ProseMirror");
  await body.click();
  await page.keyboard.type(text);
};

/** Dismisses the open dialog with `dismiss` and waits for it to shut. */
export const expectDialogClosesWhen = async (
  page: Page,
  dismiss: (page: Page) => Promise<void>,
): Promise<void> => {
  await dismiss(page);
  await waitForDialogClosed(page);
};
