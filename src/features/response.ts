/**
 * Response builder utilities for route handlers
 */

import { buildFlashCookie, type FlashLevel } from "#shared/cookies.ts";
import { stashForm } from "#shared/form-stash.ts";
import { getSavedFormData } from "#shared/forms.tsx";
import { appendIframeParam, getIframeMode } from "#shared/iframe.ts";
import { getRequestId } from "#shared/logger.ts";
import { checkoutPopupPage, paymentErrorPage } from "#templates/payment.tsx";
import {
  databaseBusyPage,
  migrationInProgressPage,
  notFoundPage,
  rateLimitedPage,
  siteNotActivatedPage,
  temporaryErrorPage,
} from "#templates/public.tsx";

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
 * Create "database too busy" response: a write couldn't acquire the lock after
 * retrying. 503 with an auto-refresh page so the request retries itself, like
 * temporaryErrorResponse but with a message naming the cause.
 */
export const databaseBusyResponse = (): Response =>
  htmlResponse(databaseBusyPage(), 503);

/**
 * Create "site not activated" response for sites whose database has not
 * been set up yet. 503 like temporaryErrorResponse, but without the
 * auto-refresh — the state only changes once someone completes /setup.
 */
export const siteNotActivatedResponse = (): Response =>
  htmlResponse(siteNotActivatedPage(), 503);

/**
 * Create "migration in progress" response, shown while another isolate runs a
 * database migration and pre-migration backup. 503 with an auto-refresh, like
 * temporaryErrorResponse, but with a message that explains the wait instead of
 * presenting it as an error.
 */
export const migrationInProgressResponse = (): Response =>
  htmlResponse(migrationInProgressPage(), 503);

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
  /** Override the flash level; defaults to success/error from `succeeded`. */
  level?: FlashLevel;
};

/**
 * Field-name segments whose values must never be written to the re-fill stash,
 * even briefly: secrets the user should re-enter rather than have persisted in
 * server memory (passwords, API/secret keys, signing tokens, the CSRF token).
 * Matched as whole underscore-delimited segments, so "monkey"/"keyword" are
 * safe. PII is deliberately not listed — restoring it is the point of the
 * feature, and it is never reflected for sensitive field *types* anyway.
 */
const SENSITIVE_STASH_KEY = /(?:^|_)(?:password|secret|token|key)(?:_|$)/i;

/**
 * On a failed PRG redirect, stash the just-submitted form values so the
 * follow-up GET can re-fill the fields. Prefers an explicitly passed form,
 * otherwise the per-request submission captured during CSRF parsing. Secret
 * fields are dropped — they should be re-entered, never persisted. Returns the
 * redemption token, or null when there is nothing (eligible) to stash.
 */
const maybeStashForm = (explicit?: URLSearchParams): string | null => {
  const source = explicit ?? getSavedFormData();
  if (!source) return null;
  const safe = new URLSearchParams();
  for (const [key, value] of source) {
    if (!SENSITIVE_STASH_KEY.test(key)) safe.append(key, value);
  }
  const serialized = safe.toString();
  return serialized ? stashForm(serialized) : null;
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
  if (!URL.canParse(target, "http://localhost")) {
    throw new TypeError("Invalid redirect URL");
  }

  const u = new URL(target, "http://localhost");
  const flashId = getRequestId();
  u.searchParams.set("flash", flashId);
  if (opts?.formId) {
    u.searchParams.set("form", opts.formId);
    u.hash = opts.formId;
  }
  const flash = buildFlashCookie(
    flashId,
    message,
    succeeded,
    opts?.result,
    opts?.level,
    succeeded ? undefined : (maybeStashForm(opts?.form) ?? undefined),
  );
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
 * Redirect with a neutral informational message (PRG pattern), e.g. confirming
 * an opt-out. Rendered in the info style rather than success or error.
 */
export const infoRedirect = (url: string, message: string): Response =>
  redirect(url, message, true, { level: "info" });

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
