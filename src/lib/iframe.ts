/**
 * Centralized iframe detection and URL helpers.
 * Iframe mode (?iframe=true) is used when ticket pages are embedded via
 * <iframe> or the embed script. It affects response strategy (popup vs redirect
 * for Stripe checkout) and template rendering (hide header, include resizer).
 *
 * The iframe mode is stored per-request (like the CSRF token store) and read
 * synchronously by CsrfForm, redirectResponse, checkoutResponse, and templates.
 */

/** Per-request iframe mode, readable synchronously by consumers */
const _iframeStore = { value: false };

/** Detect iframe mode from a request URL and store it for the current request */
export const detectIframeMode = (url: string): void => {
  _iframeStore.value = new URL(url).searchParams.get("iframe") === "true";
};

/** Get the current request's iframe mode */
export const getIframeMode = (): boolean => _iframeStore.value;

/** Append iframe=true query param to a URL when in iframe mode */
export const appendIframeParam = (url: string): string => {
  if (!_iframeStore.value) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}iframe=true`;
};
