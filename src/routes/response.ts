/**
 * Response builder utilities for route handlers
 */

import { appendIframeParam, getIframeMode } from "#lib/iframe.ts";
import { getRequestId } from "#lib/logger.ts";
import { buildFlashCookie } from "#lib/cookies.ts";
import { notFoundPage, rateLimitedPage, temporaryErrorPage } from "#templates/public.tsx";
import { checkoutPopupPage, paymentErrorPage } from "#templates/payment.tsx";

/**
 * Shared TextEncoder for pre-encoding string response bodies to Uint8Array.
 * Bunny Edge's runtime intermittently fails to decode JS string bodies
 * ("Unknown: error decoding response body"). Pre-encoding to bytes
 * bypasses the runtime's string-to-UTF8 path entirely.
 */
const encoder = new TextEncoder();
export const encodeBody = (text: string): ArrayBuffer =>
  encoder.encode(text).buffer as ArrayBuffer;

/**
 * Create HTML response
 */
export const htmlResponse = (html: string, status = 200): Response =>
  new Response(encodeBody(html), {
    headers: { "content-type": "text/html; charset=utf-8" },
    status,
  });

/**
 * Create 404 not found response
 */
export const notFoundResponse = (): Response =>
  htmlResponse(notFoundPage(), 404);

/**
 * Create 429 rate limited response for token URLs.
 * No Retry-After: exposing the lockout duration would give brute-force
 * clients a ready-made backoff schedule.
 */
export const rateLimitedResponse = (): Response =>
  htmlResponse(rateLimitedPage(), 429);

/**
 * Create payment error response
 */
export const paymentErrorResponse = (message: string, status = 400): Response =>
  htmlResponse(paymentErrorPage(message), status);

/**
 * Create temporary error response (e.g. transient CDN failures)
 * Returns a styled page with auto-refresh so the user retries automatically
 */
export const temporaryErrorResponse = (): Response =>
  htmlResponse(temporaryErrorPage(), 503);

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

/**
 * Create bare 302 redirect response (no message).
 * Use for external URLs, setup flow, public pages, and other cases
 * where the target page doesn't render success/error banners.
 * For admin redirects that should show a message, use `redirect` instead.
 * Automatically appends ?iframe=true when the current request is in iframe mode.
 */
export const redirectResponse = (url: string, cookie?: string): Response => {
  const headers: HeadersInit = {
    "content-type": "text/html; charset=utf-8",
    location: appendIframeParam(url),
  };
  if (cookie) {
    headers["set-cookie"] = cookie;
  }
  return new Response(null, { headers, status: 302 });
};

/** Options for redirect */
type RedirectOpts = {
  formId?: string;
  cookie?: string;
  form?: URLSearchParams;
  result?: string;
};

/**
 * Redirect with a success or error message (PRG pattern).
 * Stores the message in a flash cookie instead of the query string
 * to avoid leaking potentially sensitive data in URLs, browser history,
 * and referrer headers.
 * When formId is provided, adds a `form` param and `#formId` anchor so the
 * browser scrolls to the form that was just submitted.
 */
export const redirect = (
  url: string,
  message: string,
  succeeded: boolean,
  opts?: RedirectOpts,
): Response => {
  const target = opts?.form?.get("return_url") || url;
  const u = new URL(target, "http://localhost");
  const flashId = getRequestId();
  u.searchParams.set("flash", flashId);
  if (opts?.formId) {
    u.searchParams.set("form", opts.formId);
    u.hash = opts.formId;
  }
  const flash = buildFlashCookie(flashId, message, succeeded, opts?.result);
  const response = redirectResponse(u.pathname + u.search + u.hash, flash);
  if (opts?.cookie) withCookie(response, opts.cookie);
  return response;
};

/**
 * Redirect with an error message (PRG pattern).
 * Shorthand for `redirect(url, message, false, { formId })`.
 */
export const errorRedirect = (
  url: string,
  message: string,
  formId?: string,
): Response => redirect(url, message, false, formId ? { formId } : undefined);

/**
 * Create JSON response
 */
export const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(encodeBody(JSON.stringify(data)), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });

/**
 * Create plain text response
 */
export const plainResponse = (text: string, status = 200): Response =>
  new Response(encodeBody(text), {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status,
  });

/**
 * Create iCalendar response
 */
export const icsResponse = (ics: string): Response =>
  new Response(encodeBody(ics), {
    headers: { "content-type": "text/calendar; charset=utf-8" },
  });

/**
 * Create RSS/XML response
 */
export const rssResponse = (xml: string): Response =>
  new Response(encodeBody(xml), {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });

/**
 * Add cookie header to response.
 * Mutates headers in-place to avoid re-reading the response body.
 */
export const withCookie = (response: Response, cookie: string): Response => {
  response.headers.append("set-cookie", cookie);
  return response;
};
