/**
 * Payment-flow responses, split from the boot-loaded `response.ts` because
 * they pull the payment templates (and full page layout) into the graph —
 * only the lazily-loaded payment routes need them.
 */

import { getIframeMode } from "#shared/iframe.ts";
import { checkoutPopupPage, paymentErrorPage } from "#templates/payment.tsx";
import { htmlResponse, redirectResponse } from "./response.ts";

/** Owner-facing facts a payment failure page carries beside its refusal. */
export interface StaffDiagnostics {
  /** Static, known reasons a payment can sit unconfirmed. */
  reasons: string[];
  /** Labelled checkout facts the refusing branch knew. */
  rows: { label: string; value: string }[];
}

/**
 * Create payment error response. Diagnostics render only for the failure
 * paths that had a browser request to inspect; callers without one omit them.
 */
export const paymentErrorResponse = (
  message: string,
  status = 400,
  diagnostics?: StaffDiagnostics,
): Response => htmlResponse(paymentErrorPage(message, diagnostics), status);

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
