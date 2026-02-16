/// <reference lib="dom" />
/**
 * Embed setup script - third parties include this with data-events attribute.
 * Creates an iframe for the given event slugs and initialises iframe-resizer.
 *
 * Usage: <script async src="https://domain/embed.js" data-events="slug1+slug2"></script>
 */

import iframeResize from "@iframe-resizer/parent";

const script = document.currentScript as HTMLScriptElement | null;
if (script) {
  const events = script.getAttribute("data-events");
  if (events) {
    const origin = new URL(script.src).origin;

    const iframe = document.createElement("iframe");
    iframe.src = `${origin}/ticket/${events}?iframe=true`;
    iframe.style.border = "none";
    iframe.style.width = "100%";
    iframe.style.minHeight = "11rem";
    iframe.loading = "lazy";

    script.insertAdjacentElement("afterend", iframe);

    iframeResize({ license: "GPLv3" }, iframe);
  }
}
