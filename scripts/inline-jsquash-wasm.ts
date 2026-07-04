import { encodeBase64 } from "jsr:@std/encoding@^1.0.0/base64";
import { fromFileUrl } from "@std/path";
import type { OnLoadResult, OnResolveResult, Plugin } from "esbuild";
import { ASSETS, readAsset } from "../src/shared/images/wasm-assets.ts";

type ExportAsset = Pick<(typeof ASSETS)[number], "exportName">;

const IMAGES_DIR = fromFileUrl(
  new URL("../src/shared/images", import.meta.url),
);
const NAMESPACE = "inline-jsquash-wasm";

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

export const isBytesImport = (
  path: string,
  resolveDir: string,
  imagesDir: string,
): boolean => {
  const modulePath = normalizePath(path);
  const importerDir = normalizePath(resolveDir);
  const expectedDir = normalizePath(imagesDir);
  return [
    modulePath === "#shared/images/wasm-bytes.ts",
    modulePath.endsWith("/src/shared/images/wasm-bytes.ts"),
    modulePath === "./wasm-bytes.ts" && importerDir === expectedDir,
  ].some(Boolean);
};

export const buildModule = <Entry extends ExportAsset>(
  assets: readonly Entry[],
  readBytes: (asset: Entry) => Uint8Array,
): string => {
  const lines = [
    "const b64ToBytes = (b64) => {",
    "  const bin = atob(b64);",
    "  const out = new Uint8Array(bin.length);",
    "  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);",
    "  return out;",
    "};",
  ];
  for (const asset of assets) {
    const b64 = encodeBase64(readBytes(asset));
    lines.push(
      `const ${asset.exportName}Bytes = b64ToBytes(${JSON.stringify(b64)});`,
      `export const ${asset.exportName} = () => ${asset.exportName}Bytes;`,
    );
  }
  return lines.join("\n");
};

export const buildPackageModule = (): string => buildModule(ASSETS, readAsset);

export const createPlugin = (
  moduleSource: () => string | Promise<string>,
): Plugin => ({
  name: NAMESPACE,
  setup(build) {
    build.onResolve(
      { filter: /(^\.\/wasm-bytes\.ts$|images\/wasm-bytes\.ts$)/ },
      (args): OnResolveResult | undefined =>
        isBytesImport(args.path, args.resolveDir, IMAGES_DIR)
          ? { namespace: NAMESPACE, path: args.path }
          : undefined,
    );
    build.onLoad(
      { filter: /.*/, namespace: NAMESPACE },
      async (): Promise<OnLoadResult> => ({
        contents: await moduleSource(),
        loader: "ts",
      }),
    );
  },
});

export const inlineWasmPlugin = createPlugin(buildPackageModule);
