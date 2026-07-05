/**
 * Centralized iframe detection and URL helpers.
 * Iframe mode (?iframe=true) is used when ticket pages are embedded via
 * <iframe> or the embed script. It affects response strategy (popup vs redirect
 * for Stripe checkout) and template rendering (hide header, include resizer).
 *
 * The iframe mode is request-scoped (see request-scoped.ts) and read
 * synchronously by CsrfForm, redirectResponse, checkoutResponse, and templates.
 */

import { createRequestScoped } from "#shared/request-scoped.ts";

/** Per-request iframe mode, readable synchronously by consumers */
const iframeScope = createRequestScoped<{ value: boolean }>(() => ({
  value: false,
}));

/** Run a function within an iframe-mode scope (one container per request) */
export const runWithIframeContext = <T>(fn: () => T): T => iframeScope.run(fn);

/** Detect iframe mode from a request URL and store it for the current request */
export const detectIframeMode = (url: string): void => {
  if (!URL.canParse(url)) throw new TypeError("Invalid iframe detection URL");

  iframeScope.current().value =
    new URL(url).searchParams.get("iframe") === "true";
};

/** Get the current request's iframe mode */
export const getIframeMode = (): boolean => iframeScope.current().value;

/** Append iframe=true query param to a URL when in iframe mode */
export const appendIframeParam = (url: string): string => {
  if (!getIframeMode()) return url;
  if (!URL.canParse(url, "http://localhost")) {
    throw new TypeError("Invalid iframe redirect URL");
  }

  const parsed = new URL(url, "http://localhost");
  parsed.searchParams.set("iframe", "true");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
};
