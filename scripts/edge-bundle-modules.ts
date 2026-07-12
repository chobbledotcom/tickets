/**
 * Pure builders and guards for the shared edge-bundle pipeline.
 *
 * Everything here is data-in/data-out — no filesystem, no esbuild, no process
 * exit — so `edge-bundle-lib.ts` (the IO shell that reads assets and drives
 * esbuild) stays thin and these pieces are trivially unit- and mutation-tested.
 * The three `build*Module` functions produce the source text esbuild inlines in
 * place of the dev/test modules that read from disk; the guards are post-build
 * assertions on the finished bundle text.
 */

/** Asset definition: [filename, exportName, contentType, pathConstant, publishToCdn]. */
export type AssetDef = [string, string, string, string, boolean?];

export interface PublishedAssetUrls {
  origin: string;
  urls: Record<string, string>;
}

/** A post-build assertion on the bundle text; `test` truthy aborts the build. */
export interface EdgeBundleGuard {
  message: string;
  test: (content: string) => boolean;
}

/** Build the inline build-info module with timestamp and commit SHA. */
export const buildBuildInfoModule = (
  buildIso: string,
  commit: string,
): string =>
  [
    `export const BUILD_TIMESTAMP = ${JSON.stringify(buildIso)};`,
    `export const BUILD_COMMIT = ${JSON.stringify(commit)};`,
  ].join("\n");

/** Build the inline asset-paths module with cache-busted paths. */
export const buildAssetPathsModule = (
  assetDefs: AssetDef[],
  buildTs: number,
  published?: PublishedAssetUrls,
): string => {
  const paths = assetDefs
    .filter(([, , , pathConst]) => pathConst)
    .map(([filename, , , pathConst]) => {
      const publishedUrl = published?.urls[filename];
      if (publishedUrl) {
        return `export const ${pathConst} = ${JSON.stringify(publishedUrl)};`;
      }
      // Embed script should always use latest version without cache-busting
      const cacheBuster = pathConst === "EMBED_JS_PATH" ? "" : `?ts=${buildTs}`;
      return `export const ${pathConst} = "/${filename}${cacheBuster}";`;
    });
  const cdnOrigin = published ? published.origin : null;
  paths.push(`export const ASSET_CDN_ORIGIN = ${JSON.stringify(cdnOrigin)};`);
  return paths.join("\n");
};

/** Build the inline assets module with pre-read content and handler functions. */
export const buildAssetsModule = (
  assetDefs: AssetDef[],
  staticAssets: Record<string, string>,
  published?: PublishedAssetUrls,
): string => {
  const varLines = assetDefs.flatMap(([filename], i) =>
    published?.urls[filename]
      ? []
      : [`const v${i} = ${JSON.stringify(staticAssets[filename])};`],
  );

  const cacheHeader = `const CACHE_HEADERS = { "cache-control": "public, max-age=31536000, immutable" };`;

  const handlerLines = assetDefs.map(
    ([filename, exportName, contentType], i) => {
      const publishedUrl = published?.urls[filename];
      return publishedUrl
        ? `export const ${exportName} = () => new Response(null, { status: 302, headers: { location: ${JSON.stringify(publishedUrl)} } });`
        : `export const ${exportName} = () => new Response(v${i}, { headers: { "content-type": "${contentType}", ...CACHE_HEADERS } });`;
    },
  );

  // Mirror assets.ts's orderWidgetBody export with the inlined widget source.
  const orderWidget = [
    `const orderJsBody = ${JSON.stringify(staticAssets["order.js"])};`,
    "export const orderWidgetBody = () => orderJsBody;",
  ].join("\n");

  return [...varLines, cacheHeader, ...handlerLines, orderWidget].join("\n");
};

/**
 * Re-point a bundle's `sourceMappingURL` comment at a different filename. The
 * edge build renames esbuild's `edge.js.map` link to the deployed
 * `bunny-script.ts.map` so Sentry can pair the deployed bundle with its map.
 */
export const renameSourceMapLink = (
  raw: string,
  from: string,
  to: string,
): string =>
  raw.replace(`//# sourceMappingURL=${from}`, `//# sourceMappingURL=${to}`);

/**
 * Guard: the app renders with a custom JSX runtime (#jsx), never React. If
 * esbuild ever falls back to the classic JSX transform, the bundle references
 * an undefined `React` and every page 500s at runtime ("React is not defined").
 * Tests don't catch this (they run TSX under Deno), so assert on the bundle.
 */
export const reactRuntimeGuard = (label: string): EdgeBundleGuard => ({
  message: `${label} bundle contains React.createElement — JSX automatic runtime is misconfigured (expected jsx: 'automatic', jsxImportSource: '#jsx')`,
  test: (content) => content.includes("React.createElement"),
});

/** Guard: the bundle must stay under a maximum byte size (e.g. Bunny's 10MB). */
export const bundleSizeGuard = (maxBytes: number): EdgeBundleGuard => ({
  message: `Bundle size exceeds the ${maxBytes} byte limit`,
  test: (content) => content.length > maxBytes,
});

/**
 * Guard: the deploy bundle must avoid the native libsql binding.
 * `platform: "browser"` should resolve `@libsql/client` to its web export; if a
 * native `.node`/hrana-over-native path leaked in, the artifact balloons again.
 */
export const nativeLibsqlGuard: EdgeBundleGuard = {
  message:
    "Deploy bundle references a native libsql binding — expected the pure-JS web client via platform: 'browser'",
  test: (content) =>
    content.includes('.node"') || content.includes("libsql/client/."),
};
