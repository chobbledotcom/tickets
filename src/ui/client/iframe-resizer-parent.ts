/// <reference lib="dom" />
/** iframe-resizer parent - bundled for embedders to load from our domain */

import iframeResize from "@iframe-resizer/parent";

// Expose globally so the inline <script> in the embed code can call it
(window as unknown as Record<string, unknown>).iframeResize = iframeResize;
