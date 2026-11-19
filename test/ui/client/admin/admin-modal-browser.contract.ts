/**
 * The admin modal shell at its real surface: markdown previews opened from a
 * served admin page in Chromium. The direct tests in `modal.test.ts` cover the
 * rules without a layout; this file proves what only a browser shows — the
 * window stays non-modal, its stack, its drag and clamp, its minimise and
 * restore, its full-screen phone shape, and its leave warning.
 *
 * Runs under `deno task test:screenshot-contract`. The harness builds the
 * static assets before the served page loads them.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Locator, Page } from "playwright";
import { ensureMessageGroups, t } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import {
  type BrowserContract,
  describeWithBrowser,
  withSignedInPage,
} from "#test-utils/browser-contract.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";

// The served page renders catalog copy, so the contract needs the full
// message catalog whether or not the shared preload ran first.
await ensureMessageGroups(MESSAGE_GROUPS);

const MODAL = "dialog.admin-modal";
const PREVIEW_BUTTON = t("modal.preview.open");
const PREVIEW_TITLE = t("modal.preview.heading");
const DESKTOP = { height: 900, width: 1200 };
const PHONE = { height: 667, width: 375 };
const SITE_PAGE = "/admin/site/pages/new";
const CONTENT_KEY = "markdown-preview:content";

/** An element's page box. */
type Box = { height: number; width: number; x: number; y: number };

/** A page as the admin entry point loads it, at a known viewport. */
const openAdminPage = async (
  page: Page,
  path: string,
  viewport = DESKTOP,
): Promise<void> => {
  await page.setViewportSize(viewport);
  await page.goto(path);
  await page.getByRole("button", { name: PREVIEW_BUTTON }).first().waitFor();
};

/** Opens the preview for one field and waits for its window. */
const openPreview = async (
  page: Page,
  index: number,
  key: string,
): Promise<Locator> => {
  await page.getByRole("button", { name: PREVIEW_BUTTON }).nth(index).click();
  const dialog = page.locator(`dialog[data-modal-key="${key}"]`);
  await dialog.waitFor();
  return dialog;
};

/** The element's page box, failing loudly when it has none. */
const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element has no page box");
  return box;
};

/** The page's viewport, which the browser always reports. */
const viewportOf = (page: Page): { height: number; width: number } => {
  const size = page.viewportSize();
  if (size === null) throw new Error("the page has no viewport");
  return size;
};

/** The z-index the browser paints a window with. */
const zIndexOf = async (page: Page, key: string): Promise<number> =>
  Number(
    await page
      .locator(`dialog[data-modal-key="${key}"]`)
      .evaluate((dialog) => getComputedStyle(dialog).zIndex),
  );

/** Every open window, lowest first, with the key it was opened under. */
const stackOf = async (
  page: Page,
): Promise<{ key: string | null; z: number }[]> =>
  await page.evaluate(() =>
    [...document.querySelectorAll("dialog.admin-modal")]
      .map((dialog) => ({
        key: dialog.getAttribute("data-modal-key"),
        z: Number(getComputedStyle(dialog).zIndex),
      }))
      .toSorted((left, right) => left.z - right.z),
  );

/** Whether the box stays inside the viewport. */
const expectInside = (
  box: Box,
  viewport: { height: number; width: number },
): void => {
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
};

/** Press on `locator`'s centre and move the pointer by a step. The button
 *  stays down, so the caller can look at the drag in progress. */
const pressAndMove = async (
  page: Page,
  locator: Locator,
  by: { x: number; y: number },
): Promise<void> => {
  const box = await boxOf(locator);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + by.x, startY + by.y, { steps: 5 });
};

/** Whether the page stops itself from unloading. */
const leaveIsWarned = async (page: Page): Promise<boolean> =>
  await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    globalThis.dispatchEvent(event);
    return event.defaultPrevented;
  });

/** Run `check` on the site page with its preview open. */
const withPreview = async (
  contract: BrowserContract,
  check: (page: Page, dialog: Locator) => Promise<void>,
): Promise<void> =>
  await withSignedInPage(contract.browser, contract.baseUrl, async (page) => {
    await openAdminPage(page, SITE_PAGE);
    await check(page, await openPreview(page, 0, CONTENT_KEY));
  });

describeWithBrowser(
  "the admin modal shell at the served admin pages",
  { db: true },
  (contract) => {
    /** The group edit form, which carries two markdown fields. */
    const groupEditPath = async (): Promise<string> => {
      const group = await createTestGroup({
        description: "The group's own words.",
        termsAndConditions: "The group's terms.",
      });
      return `/admin/groups/${group.id}/edit`;
    };

    test("keeps the page usable and stacks the windows in use order", async () => {
      const path = await groupEditPath();
      await withSignedInPage(
        contract.browser,
        contract.baseUrl,
        async (page) => {
          await openAdminPage(page, path);
          const descriptionKey = "markdown-preview:description";
          const termsKey = "markdown-preview:termsAndConditions";

          const first = await openPreview(page, 0, descriptionKey);
          const second = await openPreview(page, 1, termsKey);

          // Two windows are open, and neither is modal: the page behind stays
          // out of the top layer, so its controls still take input.
          expect(await page.locator(MODAL).count()).toBe(2);
          const modalStates = await page.evaluate(() =>
            [...document.querySelectorAll("dialog.admin-modal")].map((dialog) =>
              dialog.matches(":modal"),
            ),
          );
          expect(modalStates).toEqual([false, false]);

          await page.locator('input[name="name"]').focus();
          expect(
            await page.evaluate(() =>
              document.activeElement?.getAttribute("name"),
            ),
          ).toBe("name");

          // The window opened last sits on top, and the words its bar shows
          // come from the catalog.
          expect(await stackOf(page)).toEqual([
            { key: descriptionKey, z: 1000 },
            { key: termsKey, z: 1001 },
          ]);
          expect(await first.locator(".admin-modal-title").textContent()).toBe(
            PREVIEW_TITLE,
          );
          expect(await second.locator(".admin-modal-title").textContent()).toBe(
            PREVIEW_TITLE,
          );

          // A press on the window behind brings it forward.
          await first.locator(".admin-modal-close").focus();
          expect(await zIndexOf(page, descriptionKey)).toBe(1001);
          expect(await zIndexOf(page, termsKey)).toBe(1000);
        },
      );
    });

    test("drags the window by its title bar and keeps it on the screen", async () => {
      await withPreview(contract, async (page, dialog) => {
        const bar = dialog.locator(".admin-modal-bar");
        const cursor = async (): Promise<string> =>
          await bar.evaluate((element) => getComputedStyle(element).cursor);
        const before = await boxOf(dialog);

        expect(await cursor()).toBe("grab");
        await pressAndMove(page, bar, { x: 40, y: 30 });
        expect(await cursor()).toBe("grabbing");
        await page.mouse.up();

        const after = await boxOf(dialog);
        expect(after.x - before.x).toBeCloseTo(40, 0);
        expect(after.y - before.y).toBeCloseTo(30, 0);
        expect(await cursor()).toBe("grab");

        // A drag that runs past the screen stops at the edge, and a smaller
        // viewport clamps the window again.
        const viewport = viewportOf(page);
        await pressAndMove(page, bar, {
          x: viewport.width,
          y: viewport.height,
        });
        await page.mouse.up();
        expectInside(await boxOf(dialog), viewport);

        const smaller = { height: 700, width: 900 };
        await page.setViewportSize(smaller);
        expectInside(await boxOf(dialog), smaller);
      });
    });

    test("minimises to its title bar and opens again from that bar", async () => {
      await withPreview(contract, async (_page, dialog) => {
        const before = await boxOf(dialog);
        await dialog.locator(".admin-modal-minimise").click();
        const body = dialog.locator(".admin-modal-body");
        expect(
          await body.evaluate((element) => getComputedStyle(element).display),
        ).toBe("none");
        const collapsed = await boxOf(dialog);
        expect(collapsed.height).toBeLessThan(before.height / 2);
        // Both controls stay on the bar when it shows only its title.
        expect(await dialog.locator(".admin-modal-close").isVisible()).toBe(
          true,
        );
        expect(await dialog.locator(".admin-modal-minimise").isVisible()).toBe(
          true,
        );

        await dialog.locator(".admin-modal-title").click();
        expect(
          await body.evaluate((element) => getComputedStyle(element).display),
        ).not.toBe("none");
        const restored = await boxOf(dialog);
        expect(restored.height).toBeCloseTo(before.height, 0);
        expect(restored.x).toBeCloseTo(before.x, 0);
        expect(restored.y).toBeCloseTo(before.y, 0);
      });
    });

    test("opens full screen on a phone, where dragging is off", async () => {
      await withSignedInPage(
        contract.browser,
        contract.baseUrl,
        async (page) => {
          await openAdminPage(page, SITE_PAGE, PHONE);
          const dialog = await openPreview(page, 0, CONTENT_KEY);
          const box = await boxOf(dialog);
          expect(box).toEqual({
            height: PHONE.height,
            width: PHONE.width,
            x: 0,
            y: 0,
          });

          await pressAndMove(page, dialog.locator(".admin-modal-bar"), {
            x: 120,
            y: 120,
          });
          await page.mouse.up();
          expect(await boxOf(dialog)).toEqual(box);
          expect(await dialog.locator(".admin-modal-close").isVisible()).toBe(
            true,
          );
          expect(
            await dialog.locator(".admin-modal-minimise").isVisible(),
          ).toBe(true);
        },
      );
    });

    test("warns before the page unloads while a window is open", async () => {
      await withPreview(contract, async (page, dialog) => {
        expect(await leaveIsWarned(page)).toBe(true);

        await dialog.locator(".admin-modal-close").click();
        await dialog.waitFor({ state: "detached" });
        expect(await leaveIsWarned(page)).toBe(false);
      });
    });
  },
);
