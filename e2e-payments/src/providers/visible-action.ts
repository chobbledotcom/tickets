import type { Frame, Locator, Page } from "playwright";

export type VisibleAction<T> = (
  locator: Locator,
  selector: string,
) => Promise<T>;

export type VisibleAttempt<T> =
  | { matched: true; value: T }
  | { matched: false };

/** Try selectors in order. A hosted control that detaches or rejects an action
 * is not ready yet, so the caller can poll this root again. */
export const tryFirstVisibleIn = async <T>(
  root: Page | Frame,
  selectors: string[],
  act: VisibleAction<T>,
): Promise<VisibleAttempt<T>> => {
  for (const selector of selectors) {
    const locator = root.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 250 })) {
        return { matched: true, value: await act(locator, selector) };
      }
    } catch {
      // The selector or hosted control is not ready in this root yet.
    }
  }
  return { matched: false };
};
