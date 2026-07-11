/**
 * Tests for the pure builders and guards behind the shared edge-bundle
 * pipeline (`scripts/edge-bundle-modules.ts`). These produce the source text
 * esbuild inlines in place of the dev/test modules that read from disk, and the
 * post-build assertions on the finished bundle. The IO shell that drives
 * esbuild (`edge-bundle-lib.ts`) is exercised by `deno task build:edge`; the
 * branch-carrying logic lives here and is unit-tested directly.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AssetDef,
  buildAssetPathsModule,
  buildAssetsModule,
  buildBuildInfoModule,
  bundleSizeGuard,
  nativeLibsqlGuard,
  reactRuntimeGuard,
  renameSourceMapLink,
} from "../../scripts/edge-bundle-modules.ts";

describe("buildBuildInfoModule", () => {
  test("emits both constants with the given timestamp and commit", () => {
    expect(buildBuildInfoModule("2026-07-04T00:00:00.000Z", "abc123")).toBe(
      [
        `export const BUILD_TIMESTAMP = "2026-07-04T00:00:00.000Z";`,
        `export const BUILD_COMMIT = "abc123";`,
      ].join("\n"),
    );
  });

  test("JSON-encodes an empty commit rather than emitting a bare token", () => {
    expect(buildBuildInfoModule("2026-01-01T00:00:00.000Z", "")).toContain(
      `export const BUILD_COMMIT = "";`,
    );
  });

  test("escapes values through JSON.stringify", () => {
    // A quote in the value must be escaped, not emitted raw, or the module
    // would be syntactically broken.
    expect(buildBuildInfoModule("2026", 'a"b')).toContain(
      `export const BUILD_COMMIT = "a\\"b";`,
    );
  });
});

const PATH_DEFS: AssetDef[] = [
  ["robots.txt", "handleRobotsTxt", "text/plain", ""],
  ["style.css", "handleStyleCss", "text/css", "CSS_PATH"],
  ["embed.js", "handleEmbedJs", "application/javascript", "EMBED_JS_PATH"],
];

describe("buildAssetPathsModule", () => {
  test("emits a const only for defs that carry a path constant", () => {
    const out = buildAssetPathsModule(PATH_DEFS, 1234);
    // robots.txt has no path constant, so it is filtered out entirely.
    expect(out).not.toContain("robots");
    expect(out).toContain("CSS_PATH");
    expect(out).toContain("EMBED_JS_PATH");
  });

  test("cache-busts normal assets with the build timestamp", () => {
    expect(buildAssetPathsModule(PATH_DEFS, 1234)).toContain(
      `export const CSS_PATH = "/style.css?ts=1234";`,
    );
  });

  test("never cache-busts the embed script (must always serve latest)", () => {
    expect(buildAssetPathsModule(PATH_DEFS, 1234)).toContain(
      `export const EMBED_JS_PATH = "/embed.js";`,
    );
  });

  test("produces exactly the path consts, newline-joined", () => {
    expect(buildAssetPathsModule(PATH_DEFS, 1234)).toBe(
      [
        `export const CSS_PATH = "/style.css?ts=1234";`,
        `export const EMBED_JS_PATH = "/embed.js";`,
        "export const ASSET_CDN_ORIGIN = null;",
      ].join("\n"),
    );
  });

  test("bakes published CDN URLs and origin into the bundle", () => {
    const paths = buildAssetPathsModule(PATH_DEFS, 1234, {
      origin: "https://assets.example.com",
      urls: {
        "style.css": "https://assets.example.com/assets/release/style.css",
      },
    });
    expect(paths).toContain(
      `export const CSS_PATH = "https://assets.example.com/assets/release/style.css";`,
    );
    expect(paths).toContain(`export const EMBED_JS_PATH = "/embed.js";`);
    expect(paths).toContain(
      `export const ASSET_CDN_ORIGIN = "https://assets.example.com";`,
    );
  });
});

const ASSET_DEFS: AssetDef[] = [
  ["favicon.svg", "handleFavicon", "image/svg+xml", ""],
  ["admin.js", "handleAdminJs", "application/javascript", "JS_PATH"],
];
const STATIC_ASSETS = {
  "admin.js": "console.log(1)",
  "favicon.svg": "<svg/>",
  "order.js": "widget-source",
};
const CDN_ASSETS = {
  origin: "https://assets.example.com",
  urls: {
    "admin.js": "https://assets.example.com/assets/release/admin.js",
  },
};

describe("buildAssetsModule", () => {
  test("declares a variable per def carrying the pre-read content", () => {
    const out = buildAssetsModule(ASSET_DEFS, STATIC_ASSETS);
    expect(out).toContain(`const v0 = "<svg/>";`);
    expect(out).toContain(`const v1 = "console.log(1)";`);
  });

  test("emits a handler wiring each export name to its content-type and var", () => {
    const out = buildAssetsModule(ASSET_DEFS, STATIC_ASSETS);
    expect(out).toContain(
      `export const handleFavicon = () => new Response(v0, { headers: { "content-type": "image/svg+xml", ...CACHE_HEADERS } });`,
    );
    expect(out).toContain(
      `export const handleAdminJs = () => new Response(v1, { headers: { "content-type": "application/javascript", ...CACHE_HEADERS } });`,
    );
  });

  test("declares the immutable cache header once", () => {
    expect(buildAssetsModule(ASSET_DEFS, STATIC_ASSETS)).toContain(
      `const CACHE_HEADERS = { "cache-control": "public, max-age=31536000, immutable" };`,
    );
  });

  test("mirrors assets.ts's orderWidgetBody from the inlined order.js", () => {
    const out = buildAssetsModule(ASSET_DEFS, STATIC_ASSETS);
    expect(out).toContain(`const orderJsBody = "widget-source";`);
    expect(out).toContain("export const orderWidgetBody = () => orderJsBody;");
  });

  test("redirects published assets without embedding their bodies", () => {
    const out = buildAssetsModule(ASSET_DEFS, STATIC_ASSETS, CDN_ASSETS);
    expect(out).not.toContain("console.log(1)");
    expect(out).toContain(
      `export const handleAdminJs = () => Response.redirect("https://assets.example.com/assets/release/admin.js", 302);`,
    );
    expect(out).toContain(`const v0 = "<svg/>";`);
  });

  test("produces exactly the vars, cache header, handlers, and widget, newline-joined", () => {
    expect(buildAssetsModule(ASSET_DEFS, STATIC_ASSETS)).toBe(
      [
        `const v0 = "<svg/>";`,
        `const v1 = "console.log(1)";`,
        `const CACHE_HEADERS = { "cache-control": "public, max-age=31536000, immutable" };`,
        `export const handleFavicon = () => new Response(v0, { headers: { "content-type": "image/svg+xml", ...CACHE_HEADERS } });`,
        `export const handleAdminJs = () => new Response(v1, { headers: { "content-type": "application/javascript", ...CACHE_HEADERS } });`,
        `const orderJsBody = "widget-source";`,
        "export const orderWidgetBody = () => orderJsBody;",
      ].join("\n"),
    );
  });
});

describe("renameSourceMapLink", () => {
  test("re-points the sourceMappingURL comment at the new filename", () => {
    expect(
      renameSourceMapLink(
        "code;\n//# sourceMappingURL=edge.js.map",
        "edge.js.map",
        "bunny-script.ts.map",
      ),
    ).toBe("code;\n//# sourceMappingURL=bunny-script.ts.map");
  });

  test("leaves content untouched when the link is absent", () => {
    expect(renameSourceMapLink("no map here", "edge.js.map", "x.map")).toBe(
      "no map here",
    );
  });
});

describe("reactRuntimeGuard", () => {
  test("trips when the bundle references React.createElement", () => {
    expect(
      reactRuntimeGuard("Edge").test("var x = React.createElement()"),
    ).toBe(true);
  });

  test("passes a bundle using the automatic JSX runtime", () => {
    expect(reactRuntimeGuard("Edge").test("import { jsx } from '#jsx'")).toBe(
      false,
    );
  });

  test("labels the message with the given build name", () => {
    expect(reactRuntimeGuard("Deploy").message).toContain("Deploy bundle");
  });
});

describe("bundleSizeGuard", () => {
  test("trips when the bundle exceeds the limit", () => {
    expect(bundleSizeGuard(3).test("abcd")).toBe(true);
  });

  test("passes a bundle exactly at the limit", () => {
    // Boundary: `> max`, so an exactly-max bundle is allowed.
    expect(bundleSizeGuard(4).test("abcd")).toBe(false);
  });

  test("names the byte limit in its message", () => {
    expect(bundleSizeGuard(10_000_000).message).toContain("10000000");
  });
});

describe("nativeLibsqlGuard", () => {
  test('trips on a native ".node" binding reference', () => {
    expect(nativeLibsqlGuard.test('require("foo.node")')).toBe(true);
  });

  test("trips on a native libsql client path reference", () => {
    expect(nativeLibsqlGuard.test("libsql/client/.")).toBe(true);
  });

  test("passes the pure-JS web client bundle", () => {
    expect(nativeLibsqlGuard.test("libsql/client/web")).toBe(false);
  });

  test("explains the native-binding failure in its message", () => {
    expect(nativeLibsqlGuard.message).toBe(
      "Deploy bundle references a native libsql binding — expected the pure-JS web client via platform: 'browser'",
    );
  });
});
