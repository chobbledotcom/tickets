import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  OnLoadArgs,
  OnLoadResult,
  OnResolveArgs,
  OnResolveResult,
  PluginBuild,
} from "esbuild";
import { ASSETS } from "#shared/images/wasm-assets.ts";
import {
  buildModule,
  buildPackageModule,
  createPlugin,
  isBytesImport,
} from "../../scripts/inline-jsquash-wasm.ts";

type ResolveCallback = Parameters<PluginBuild["onResolve"]>[1];
type LoadCallback = Parameters<PluginBuild["onLoad"]>[1];

const fakePluginBuild = (): {
  build: PluginBuild;
  loadCallbacks: LoadCallback[];
  resolveCallbacks: ResolveCallback[];
} => {
  const resolveCallbacks: ResolveCallback[] = [];
  const loadCallbacks: LoadCallback[] = [];
  const build = {
    onLoad(
      _options: Parameters<PluginBuild["onLoad"]>[0],
      callback: LoadCallback,
    ) {
      loadCallbacks.push(callback);
    },
    onResolve(
      _options: Parameters<PluginBuild["onResolve"]>[0],
      callback: ResolveCallback,
    ) {
      resolveCallbacks.push(callback);
    },
  } as unknown as PluginBuild;
  return { build, loadCallbacks, resolveCallbacks };
};

describe("isBytesImport", () => {
  test("matches the shared image wasm module and rejects unrelated imports", () => {
    const imagesDir = "/repo/src/shared/images";
    expect(
      isBytesImport(
        "#shared/images/wasm-bytes.ts",
        "/repo/src/shared/images",
        imagesDir,
      ),
    ).toBe(true);
    expect(
      isBytesImport(
        "/repo/src/shared/images/wasm-bytes.ts",
        "/repo/src/shared/images",
        imagesDir,
      ),
    ).toBe(true);
    expect(isBytesImport("./wasm-bytes.ts", imagesDir, imagesDir)).toBe(true);
    expect(
      isBytesImport("./wasm-bytes.ts", "/repo/src/shared/other", imagesDir),
    ).toBe(false);
    expect(isBytesImport("./other.ts", imagesDir, imagesDir)).toBe(false);
  });
});

describe("buildModule", () => {
  test("builds base64-backed exports from supplied bytes", () => {
    const source = buildModule(
      [{ exportName: "jpegDec" }, { exportName: "webpEnc" }] as const,
      (asset) =>
        asset.exportName === "jpegDec"
          ? new Uint8Array([1, 2, 3])
          : new Uint8Array([4, 5]),
    );
    expect(source).toContain('const jpegDecBytes = b64ToBytes("AQID");');
    expect(source).toContain("export const jpegDec = () => jpegDecBytes;");
    expect(source).toContain('const webpEncBytes = b64ToBytes("BAU=");');
    expect(source).toContain("export const webpEnc = () => webpEncBytes;");
  });

  test("builds the real jSquash module with every expected export", () => {
    const source = buildPackageModule();
    for (const asset of ASSETS) {
      expect(source).toContain(`export const ${asset.exportName} = () =>`);
    }
    expect(source).not.toContain("src/shared/images/wasm");
  });
});

describe("createPlugin", () => {
  test("registers a resolver and loader for the wasm-bytes module", async () => {
    const { build, loadCallbacks, resolveCallbacks } = fakePluginBuild();
    const plugin = createPlugin(() => "export const ok = true;");
    plugin.setup(build);

    const resolved = (await resolveCallbacks[0]!({
      path: "#shared/images/wasm-bytes.ts",
      resolveDir: "/repo/src/shared/images",
    } as OnResolveArgs)) as OnResolveResult;
    expect(resolved).toEqual({
      namespace: "inline-jsquash-wasm",
      path: "#shared/images/wasm-bytes.ts",
    });
    const ignored = await resolveCallbacks[0]!({
      path: "./other.ts",
      resolveDir: "/repo/src/shared/images",
    } as OnResolveArgs);
    expect(ignored).toBeUndefined();

    const loaded = (await loadCallbacks[0]!({} as OnLoadArgs)) as OnLoadResult;
    expect(loaded).toEqual({
      contents: "export const ok = true;",
      loader: "ts",
    });
  });
});
