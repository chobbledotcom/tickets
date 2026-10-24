/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Scroll parent page so the iframe is visible on checkout and success pages.
 * parentIframe is created synchronously by iframe-resizer-child (loaded before
 * this deferred script) and buffers calls until the parent handshake completes.
 * scrollToOffset(0, 0) scrolls the parent to the iframe's top-left corner. */

import "#src/ui/client/window-globals.ts";

export const initIframeScrollIntoView = (): void => {
  if (!document.querySelector("[data-scroll-into-view]")) return;
  const { parentIframe } = window;
  parentIframe?.scrollToOffset(0, 0);
};
