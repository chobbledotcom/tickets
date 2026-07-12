import { CSS, JS, SVG, TEXT } from "../src/shared/content-types.ts";
import { ASSETS, readAsset } from "../src/shared/images/wasm-assets.ts";
import type { AssetDef } from "./edge-bundle-modules.ts";
import { wasmFilename } from "./inline-jsquash-wasm.ts";
import type { StaticCdnAsset } from "./static-cdn.ts";

/** One schema drives embedded handlers, public paths, and CDN publication. */
export const ASSET_DEFS: AssetDef[] = [
  ["robots.txt", "handleRobotsTxt", TEXT, ""],
  ["favicon.svg", "handleFavicon", SVG, ""],
  ["icons.svg", "handleIcons", SVG, "ICONS_PATH"],
  ["style.css", "handleStyleCss", CSS, "CSS_PATH", true],
  ["admin.js", "handleAdminJs", JS, "JS_PATH", true],
  // The client loader derives these sibling URLs from admin.js.
  ["markdown-editor.js", "handleMarkdownEditorJs", JS, "", true],
  ["logistics-map.js", "handleLogisticsMapJs", JS, "", true],
  ["logistics-map.css", "handleLogisticsMapCss", CSS, "", true],
  ["scanner.js", "handleScannerJs", JS, "SCANNER_JS_PATH", true],
  [
    "iframe-resizer-parent.js",
    "handleIframeResizerParentJs",
    JS,
    "IFRAME_RESIZER_PARENT_JS_PATH",
  ],
  [
    "iframe-resizer-child.js",
    "handleIframeResizerChildJs",
    JS,
    "IFRAME_RESIZER_CHILD_JS_PATH",
    true,
  ],
  ["embed.js", "handleEmbedJs", JS, "EMBED_JS_PATH"],
  ["contact.js", "handleContactJs", JS, "CONTACT_JS_PATH", true],
];

export const buildCdnAssets = (
  staticAssets: Record<string, string>,
): StaticCdnAsset[] => [
  ...ASSET_DEFS.filter(([, , , , publishToCdn]) => publishToCdn).map(
    ([filename, , contentType]) => {
      const content = staticAssets[filename];
      if (content === undefined) {
        throw new Error(`Missing built static asset ${filename}`);
      }
      return {
        bytes: new TextEncoder().encode(content),
        contentType,
        filename,
      };
    },
  ),
  ...ASSETS.map((asset) => ({
    bytes: readAsset(asset),
    contentType: "application/wasm",
    filename: wasmFilename(asset),
  })),
];
