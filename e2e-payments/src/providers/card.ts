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

/**
 * Fill a single input that lives inside a cross-origin iframe, located by the
 * iframe's title (case-insensitive substring). frameLocator auto-waits for the
 * iframe and its input to attach, which is more robust than enumerating
 * page.frames() and racing their load — the approach that works for the card
 * fields on Stripe Checkout and the Braintree hosted fields SumUp embeds.
 * Returns false (rather than throwing) if the frame/input never shows, so
 * callers can fall back to a same-frame search.
 */
export const fillFrameInput = async (
  page: Page,
  label: string,
  titleSubstrings: string[],
  inputSelector: string,
  value: string,
  timeoutMs = 8_000,
): Promise<boolean> => {
  const selector = titleSubstrings
    .map((t) => `iframe[title*="${t}" i]`)
    .join(", ");
  const input = page.frameLocator(selector).locator(inputSelector).first();
  try {
    await input.fill(value, { timeout: timeoutMs });
    log(`  filled ${label} (iframe by title)`);
    return true;
  } catch {
    return false;
  }
};

/** Sandbox card details to enter on a hosted checkout page. */
export interface CardDetails {
  number: string;
  /** Expiry as digits or MM/YY — fields auto-format on input. */
  expiry: string;
  cvc: string;
  name?: string;
  postal?: string;
  email?: string;
}

/**
 * Standard, provider-agnostic candidate selectors for each card field. Payment
 * forms follow the WHATWG autocomplete tokens (cc-number/cc-exp/cc-csc/cc-name),
 * so those are tried first; the rest are common name/id/placeholder/aria
 * fallbacks. fillFirst also searches child frames, covering SDK iframes.
 */
const CARD_SELECTORS: Record<string, string[]> = {
  number: [
    'input[autocomplete="cc-number"]',
    'input[name="cardnumber"]',
    'input[name="cardNumber"]',
    'input[name="number"]',
    'input[id*="card-number" i]',
    'input[id*="cardnumber" i]',
    'input[name*="cardnumber" i]',
    'input[placeholder*="card number" i]',
    'input[aria-label*="card number" i]',
    "#cardNumber",
  ],
  expiry: [
    'input[autocomplete="cc-exp"]',
    'input[name="exp-date"]',
    'input[name="expiry"]',
    'input[name="expiration"]',
    'input[name="expirationDate"]',
    'input[name="expiryDate"]',
    'input[name="cardExpiry"]',
    'input[id*="expir" i]',
    'input[placeholder*="mm / yy" i]',
    'input[placeholder*="mm/yy" i]',
    'input[aria-label*="expir" i]',
    "#cardExpiry",
  ],
  cvc: [
    'input[autocomplete="cc-csc"]',
    'input[name="cvc"]',
    'input[name="cvv"]',
    'input[name="cvcNumber"]',
    'input[name="securityCode"]',
    'input[id*="cvc" i]',
    'input[id*="cvv" i]',
    'input[placeholder*="cvc" i]',
    'input[placeholder*="cvv" i]',
    'input[aria-label*="security code" i]',
    "#cardCvc",
  ],
  name: [
    'input[autocomplete="cc-name"]',
    'input[name="cardholder-name"]',
    'input[name="cardHolder"]',
    'input[name="card-holder-name"]',
    'input[name="name"]',
    'input[id*="cardholder" i]',
    'input[placeholder*="name on card" i]',
    'input[aria-label*="cardholder" i]',
    "#billingName",
  ],
  postal: [
    'input[autocomplete="postal-code"]',
    'input[autocomplete="billing postal-code"]',
    'input[name="postal"]',
    'input[name="postalCode"]',
    'input[name="postal-code"]',
    'input[name="zip"]',
    'input[id*="postal" i]',
    'input[id*="zip" i]',
    "#billingPostalCode",
  ],
  email: [
    'input[autocomplete="email"]',
    'input[type="email"]',
    'input[name="email"]',
    "#email",
  ],
};

/** Fill a hosted checkout's card form using the standard selectors. */
export const fillCard = async (
  page: Page,
  card: CardDetails,
): Promise<void> => {
  if (card.email) {
    await fillFirst(page, "email", CARD_SELECTORS.email, card.email, {
      required: false,
    });
  }
  await fillFirst(page, "card number", CARD_SELECTORS.number, card.number);
  await fillFirst(page, "expiry", CARD_SELECTORS.expiry, card.expiry);
  await fillFirst(page, "cvc", CARD_SELECTORS.cvc, card.cvc);
  if (card.name) {
    await fillFirst(page, "cardholder name", CARD_SELECTORS.name, card.name, {
      required: false,
    });
  }
  if (card.postal) {
    await fillFirst(page, "postal code", CARD_SELECTORS.postal, card.postal, {
      required: false,
    });
  }
};
