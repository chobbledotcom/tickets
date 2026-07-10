/**
 * Payment-flow responses. These live apart from `response.ts` because they
 * pull in the payment templates (and through them the full page layout) —
 * `response.ts` is loaded on every isolate boot, while these are only needed
 * by the lazily-loaded payment routes.
 */

import { getIframeMode } from "#shared/iframe.ts";
import { checkoutPopupPage, paymentErrorPage } from "#templates/payment.tsx";
import { htmlResponse, redirectResponse } from "./response.ts";

/**
 * Create payment error response
 */
export const paymentErrorResponse = (message: string, status = 400): Response =>
  htmlResponse(paymentErrorPage(message), status);

/**
 * Respond with checkout: popup page in iframe mode, 302 redirect otherwise.
 * Stripe Checkout cannot run inside iframes, so we show a page that opens
 * the checkout URL in a popup window instead.
 * Reads iframe mode from the per-request store (set by detectIframeMode).
 */
export const checkoutResponse = (checkoutUrl: string): Response =>
  getIframeMode()
    ? htmlResponse(checkoutPopupPage(checkoutUrl))
    : redirectResponse(checkoutUrl);
