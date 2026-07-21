import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ASSET_DEFS, buildCdnAssets } from "#scripts/edge-cdn-assets.ts";

const CDN_STATIC_FILENAMES = [
  "style.css",
  "admin.js",
  "markdown-editor.js",
  "logistics-map.js",
  "logistics-map.css",
  "scanner.js",
  "iframe-resizer-child.js",
  "contact.js",
] as const;

test("ASSET_DEFS describes every embedded and published browser asset", () => {
  const byFilename = Object.fromEntries(
    ASSET_DEFS.map(([filename, ...definition]) => [filename, definition]),
  );
  expect(byFilename).toEqual({
    "admin.js": [
      "handleAdminJs",
      "application/javascript; charset=utf-8",
      "JS_PATH",
      true,
    ],
    "contact.js": [
      "handleContactJs",
      "application/javascript; charset=utf-8",
      "CONTACT_JS_PATH",
      true,
    ],
    "embed.js": [
      "handleEmbedJs",
      "application/javascript; charset=utf-8",
      "EMBED_JS_PATH",
    ],
    "favicon.svg": ["handleFavicon", "image/svg+xml", ""],
    "icons.svg": ["handleIcons", "image/svg+xml", "ICONS_PATH"],
    "iframe-resizer-child.js": [
      "handleIframeResizerChildJs",
      "application/javascript; charset=utf-8",
      "IFRAME_RESIZER_CHILD_JS_PATH",
      true,
    ],
    "iframe-resizer-parent.js": [
      "handleIframeResizerParentJs",
      "application/javascript; charset=utf-8",
      "IFRAME_RESIZER_PARENT_JS_PATH",
    ],
    "logistics-map.css": [
      "handleLogisticsMapCss",
      "text/css; charset=utf-8",
      "",
      true,
    ],
    "logistics-map.js": [
      "handleLogisticsMapJs",
      "application/javascript; charset=utf-8",
      "",
      true,
    ],
    "markdown-editor.js": [
      "handleMarkdownEditorJs",
      "application/javascript; charset=utf-8",
      "",
      true,
    ],
    "robots.txt": ["handleRobotsTxt", "text/plain; charset=utf-8", ""],
    "scanner.js": [
      "handleScannerJs",
      "application/javascript; charset=utf-8",
      "SCANNER_JS_PATH",
      true,
    ],
    "style.css": [
      "handleStyleCss",
      "text/css; charset=utf-8",
      "CSS_PATH",
      true,
    ],
  });
});

test("buildCdnAssets publishes the complete site-independent release", () => {
  const assets = buildCdnAssets(
    Object.fromEntries(
      CDN_STATIC_FILENAMES.map((filename) => [filename, filename]),
    ),
  );

  expect(assets.map(({ filename }) => filename).toSorted()).toEqual(
    [
      ...CDN_STATIC_FILENAMES,
      "jpegDec.wasm",
      "pngDec.wasm",
      "webpDec.wasm",
      "webpEnc.wasm",
      "webpEncSimd.wasm",
    ].toSorted(),
  );
  expect(assets.find(({ filename }) => filename === "admin.js")?.bytes).toEqual(
    new TextEncoder().encode("admin.js"),
  );
  expect(
    assets.find(({ filename }) => filename === "jpegDec.wasm")?.bytes.length,
  ).toBeGreaterThan(0);
  expect(
    assets
      .filter(({ filename }) => filename.endsWith(".wasm"))
      .map(({ contentType }) => contentType),
  ).toEqual(Array(5).fill("application/wasm"));
});

test("buildCdnAssets fails when a publishable browser asset is missing", () => {
  expect(() => buildCdnAssets({})).toThrow(
    "Missing built static asset style.css",
  );
});
