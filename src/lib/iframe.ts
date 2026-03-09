/**
 * Centralized iframe detection and URL helpers.
 * Iframe mode (?iframe=true) is used when ticket pages are embedded via
 * <iframe> or the embed script. It affects response strategy (popup vs redirect
 * for Stripe checkout) and template rendering (hide header, include resizer).
 */

/** Check if request URL has ?iframe=true */
export const isIframeRequest = (url: string): boolean =>
  new URL(url).searchParams.get("iframe") === "true";

/** Append iframe=true query param to a URL when in iframe mode */
export const appendIframeParam = (url: string, inIframe: boolean): string => {
  if (!inIframe) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}iframe=true`;
};
