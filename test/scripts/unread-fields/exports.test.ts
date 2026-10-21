import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type InfoJson,
  pathsFromInfo,
} from "#scripts/unread-fields/bare-paths.ts";

/** The export map one fixture package declares, keyed by the cached folder
 * the mapping derives. */
const exportsMaps =
  (maps: Record<string, unknown>) =>
  (folder: string): unknown =>
    maps[folder];

/** The fixture packages name no export map, so a subpath is a plain file of
 * the package folder. */
const noExportMaps = (): undefined => undefined;

/** The fixture cache keeps every file an export map names. */
const holdsEveryFile = (): boolean => true;

/** The fixture cache keeps none of the files an export map names. */
const holdsNoFile = (): boolean => false;

/** The graph `deno info --json` prints for an entry whose only bare import
 * is one subpath of one npm package. The arguments are the package the graph
 * resolves, the module specifier it names, and the two spellings of the
 * import: the constraint the repository writes and the bare specifier it
 * carries. */
const subpathGraph = (
  pkg: { name: string; version: string },
  module: string,
  constraint: string,
  specifier: string,
): InfoJson => ({
  modules: [
    {
      local: null,
      npmPackage: `${pkg.name}@${pkg.version}`,
      specifier: module,
    },
    {
      dependencies: [{ code: { specifier: constraint }, specifier }],
      local: "/repo/src/index.ts",
      specifier: "./src/index.ts",
    },
  ],
  npmPackages: {
    [`${pkg.name}@${pkg.version}`]: {
      name: pkg.name,
      registryUrl: "https://registry.npmjs.org/",
      version: pkg.version,
    },
  },
  redirects: { [constraint]: module },
});

/** The graph for the `@libsql/core/config` import the repository writes, and
 * the cached folder the mapping derives for the package. */
const libsqlGraph = subpathGraph(
  { name: "@libsql/core", version: "0.17.2" },
  "npm:/@libsql/core@0.17.2/config",
  "npm:@libsql/core@0.17.2/config",
  "@libsql/core/config",
);
const libsqlFolder =
  "/home/me/.cache/deno/npm/registry.npmjs.org/@libsql/core/0.17.2";

describe("the paths an npm subpath takes", () => {
  test("maps a bare npm subpath to its file in the package folder", () => {
    expect(
      pathsFromInfo(
        subpathGraph(
          { name: "@jsquash/jpeg", version: "1.6.0" },
          "npm:/@jsquash/jpeg@1.6.0/decode.js",
          "npm:/@jsquash/jpeg@^1.5.0/decode.js",
          "@jsquash/jpeg/decode.js",
        ),
        "/home/me/.cache/deno/npm",
        noExportMaps,
        holdsEveryFile,
      ),
    ).toEqual({
      "@jsquash/jpeg/decode.js": [
        "/home/me/.cache/deno/npm/registry.npmjs.org/@jsquash/jpeg/1.6.0/decode.js",
      ],
    });
  });

  test("maps an exported subpath to the file the package names", () => {
    // The pinned @libsql/core publishes only lib-esm and lib-cjs, and its
    // export map sends ./config to lib-esm/config.d.ts. A target at the
    // subpath itself names no file, and the shapes it types dropped out of
    // the report.
    const map = exportsMaps({
      [libsqlFolder]: {
        "./config": {
          import: "./lib-esm/config.js",
          require: "./lib-cjs/config.js",
          types: "./lib-esm/config.d.ts",
        },
      },
    });
    expect(
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toEqual({
      "@libsql/core/config": [`${libsqlFolder}/lib-esm/config.d.ts`],
    });
  });

  test("reads the types condition ahead of the import condition", () => {
    const map = exportsMaps({
      [libsqlFolder]: {
        "./config": {
          import: "./lib-esm/config.js",
          types: "./lib-esm/config.d.ts",
        },
      },
    });
    expect(
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toEqual({
      "@libsql/core/config": [`${libsqlFolder}/lib-esm/config.d.ts`],
    });
  });

  test("reads the default condition when no other one names a file", () => {
    const map = exportsMaps({
      [libsqlFolder]: { "./config": { default: "./lib-esm/config.js" } },
    });
    expect(
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toEqual({
      "@libsql/core/config": [`${libsqlFolder}/lib-esm/config.js`],
    });
  });

  test("fills a pattern key's star with the subpath", () => {
    const map = exportsMaps({
      [libsqlFolder]: { "./*": "./lib-esm/*.d.ts" },
    });
    expect(
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toEqual({
      "@libsql/core/config": [`${libsqlFolder}/lib-esm/config.d.ts`],
    });
  });

  test("prefers the pattern whose star sits deepest", () => {
    // The sort compares the pattern keys with each other, so one key alone
    // never reaches the sort. The keys cover the rule: the deepest star
    // stands for the subpath first, the longer key breaks a tie, and a
    // pattern whose prefix misses the subpath drops out.
    const map = exportsMaps({
      [libsqlFolder]: {
        "./*": "./lib-esm/all/*.d.ts",
        "./*fig": "./lib-esm/fig/*.d.ts",
        "./con*": "./lib-esm/con/*.d.ts",
        "./x/*": "./lib-esm/x/*.d.ts",
      },
    });
    expect(
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toEqual({
      "@libsql/core/config": [`${libsqlFolder}/lib-esm/con/fig.d.ts`],
    });
  });

  test("says so when the export map answers no subpath", () => {
    // A package with an export map keeps every unlisted file out, so the
    // runtime could not have resolved the subpath the graph names either.
    const map = exportsMaps({
      [libsqlFolder]: { "./api": "./lib-esm/api.d.ts" },
    });
    expect(() =>
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toThrow(`The package at ${libsqlFolder} exports no ./config`);
  });

  test("says so when the conditions name no file the mapping reads", () => {
    const map = exportsMaps({
      [libsqlFolder]: { "./config": { require: "./lib-cjs/config.js" } },
    });
    expect(() =>
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toThrow(
      `The package at ${libsqlFolder} exports ./config through conditions the mapping cannot read`,
    );
  });

  test("says so when an export value is neither a path nor a condition map", () => {
    const map = exportsMaps({ [libsqlFolder]: { "./config": null } });
    expect(() =>
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toThrow(
      `The package at ${libsqlFolder} exports ./config through a value the mapping cannot read`,
    );
  });

  test("says so when an export value is not a package path", () => {
    const map = exportsMaps({
      [libsqlFolder]: { "./config": "lib-esm/config.d.ts" },
    });
    expect(() =>
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toThrow(
      `The package at ${libsqlFolder} exports ./config as lib-esm/config.d.ts, which is not a package path`,
    );
  });

  test("says so when a package exports a root its subpaths cannot pass", () => {
    const map = exportsMaps({ [libsqlFolder]: "./lib-esm/api.d.ts" });
    expect(() =>
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toThrow(
      `The package at ${libsqlFolder} exports only its root, not ./config`,
    );
  });

  test("says so when a package declares a map the mapping cannot read", () => {
    const map = exportsMaps({ [libsqlFolder]: ["./lib-esm/api.d.ts"] });
    expect(() =>
      pathsFromInfo(
        libsqlGraph,
        "/home/me/.cache/deno/npm",
        map,
        holdsEveryFile,
      ),
    ).toThrow(
      `The package at ${libsqlFolder} declares an export map the mapping cannot read`,
    );
  });

  test("says so when the cache holds none of the file the map names", () => {
    // A map that names a file the package does not ship would leave the
    // compiler to resolve nothing, and the report would shrink in silence.
    const map = exportsMaps({
      [libsqlFolder]: { "./config": "./lib-esm/absent.d.ts" },
    });
    expect(() =>
      pathsFromInfo(libsqlGraph, "/home/me/.cache/deno/npm", map, holdsNoFile),
    ).toThrow(
      `The cached package at ${libsqlFolder} maps its /config to ${libsqlFolder}/lib-esm/absent.d.ts, and the cache holds no such file`,
    );
  });
});
