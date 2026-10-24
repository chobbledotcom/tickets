/**
 * Typed globals on the embed surface. The bundles that read or write them
 * share this module. One is the resize function the parent bundle installs
 * for the embed loader. The other is the child handle the ticket page's
 * scripts read to scroll the host page.
 */

import type { iframeResizer } from "@iframe-resizer/child";
import type iframeResize from "@iframe-resizer/parent";

declare global {
  interface Window {
    /** Installed by iframe-resizer-parent.js for the embed loader. */
    iframeResize: typeof iframeResize;
    /** Created synchronously by iframe-resizer-child.js inside the ticket
     * page. Optional, because it exists only after the child loaded. */
    parentIframe?: iframeResizer.IFramePage;
  }
}
