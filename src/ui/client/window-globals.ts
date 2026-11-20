/**
 * Typed globals that bundles share. The bundles that read or write them share
 * this module. Two are on the embed surface: the resize function the parent
 * bundle installs for the embed loader, and the child handle the ticket
 * page's scripts read to scroll the host page. The third is the admin
 * windows' state, which the admin bundle and the markdown editor bundle
 * both read.
 */

import type { iframeResizer } from "@iframe-resizer/child";
import type iframeResize from "@iframe-resizer/parent";
import type { AdminModalLifecycle } from "#src/ui/client/admin/modal.ts";

declare global {
  interface Window {
    /** The admin windows' stack, focus, and shells. The admin bundle and the
     * markdown editor bundle each carry a copy of the modal module, and the
     * windows of both must share one stack and one focus. Absent until the
     * first window opens or the admin shell starts. */
    adminModalLifecycle?: AdminModalLifecycle;
    /** Installed by iframe-resizer-parent.js for the embed loader. */
    iframeResize: typeof iframeResize;
    /** Created synchronously by iframe-resizer-child.js inside the ticket
     * page. Optional, because it exists only after the child loaded. */
    parentIframe?: iframeResizer.IFramePage;
  }
}
