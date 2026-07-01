/**
 * Resilient helpers for filling a hosted-checkout card form. Hosted pages differ
 * across providers and change over time — some put card inputs at the top level
 * (Stripe Checkout), others inside iframes (Square/SumUp Web Payments SDK). Each
 * logical field is therefore tried against a list of candidate selectors, in the
 * top document and inside every same-origin-accessible iframe, so a provider
 * tweak to one selector doesn't break the whole flow.
 */

import type { Frame, Locator, Page } from "playwright";
import { log, warn } from "../log.ts";

const FILL_TIMEOUT = 8_000;

/** All frames worth searching: the main frame plus every child frame. */
const searchRoots = (page: Page): (Page | Frame)[] => [page, ...page.frames()];

/** Try each selector across the page and its frames; fill the first that shows. */
export const fillFirst = async (
  page: Page,
  label: string,
  selectors: string[],
  value: string,
  { required = true }: { required?: boolean } = {},
): Promise<boolean> => {
  const deadline = Date.now() + FILL_TIMEOUT;
  while (Date.now() < deadline) {
    for (const root of searchRoots(page)) {
      for (const selector of selectors) {
        const loc: Locator = root.locator(selector).first();
        try {
          if (await loc.isVisible({ timeout: 250 })) {
            await loc.fill(value, { timeout: FILL_TIMEOUT });
            log(`  filled ${label} via "${selector}"`);
            return true;
          }
        } catch {
          // selector not present in this root right now
        }
      }
    }
    await page.waitForTimeout(250);
  }
  const msg = `could not locate field "${label}" on the hosted checkout page`;
  if (required) throw new Error(msg);
  warn(`  ${msg} (optional — continuing)`);
  return false;
};

/** Click the first visible submit control matching any candidate selector. */
export const clickFirst = async (
  page: Page,
  label: string,
  selectors: string[],
): Promise<void> => {
  const deadline = Date.now() + FILL_TIMEOUT;
  while (Date.now() < deadline) {
    for (const root of searchRoots(page)) {
      for (const selector of selectors) {
        const loc = root.locator(selector).first();
        try {
          if (await loc.isVisible({ timeout: 250 })) {
            await loc.click({ timeout: FILL_TIMEOUT });
            log(`  clicked ${label} via "${selector}"`);
            return;
          }
        } catch {
          // not present yet
        }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`could not locate "${label}" control on the hosted checkout page`);
};
