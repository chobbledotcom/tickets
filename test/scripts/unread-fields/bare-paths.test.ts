import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  barePaths,
  type InfoJson,
  type InfoModule,
  pathsFromInfo,
} from "#scripts/unread-fields/bare-paths.ts";

/** The fixture packages name no export map, so a subpath is a plain file of
 * the package folder. */
const noExportMaps = (): undefined => undefined;

/** The fixture cache keeps every package folder the graph names. */
const holdsEveryFolder = (): boolean => true;

/** The fixture cache keeps no package folder the graph names. */
const holdsNoFolder = (): boolean => false;

/** The paths the mapping reports when the cache holds every package folder
 * the graph names. */
const pathsFromAFilledCache = (
  info: InfoJson,
  npmCache: string,
): Record<string, string[]> =>
  pathsFromInfo(info, npmCache, noExportMaps, undefined, holdsEveryFolder);

/** The graph `deno info --json` prints for an entry that imports valibot. */
const valibotModule: InfoModule = {
  local: null,
  npmPackage: "valibot@1.4.1",
  specifier: "npm:/valibot@1.4.1",
};

const entryImportingValibotByCode = {
  dependencies: [
    { code: { specifier: "npm:valibot@^1.4.1" }, specifier: "valibot" },
  ],
  local: "/repo/src/index.ts",
  specifier: "./src/index.ts",
};

const valibotGraph: InfoJson = {
  modules: [valibotModule, entryImportingValibotByCode],
  npmCache: "/home/me/.cache/deno/npm",
  npmPackages: {
    "valibot@1.4.1": {
      name: "valibot",
      registryUrl: "https://registry.npmjs.org/",
      version: "1.4.1",
    },
  },
  redirects: { "npm:valibot@^1.4.1": "npm:/valibot@1.4.1" },
};

/** The entry module of the graph for an entry whose only bare imports are
 * jsr packages. */
const stdPathEntry = {
  dependencies: [
    { code: { specifier: "jsr:@std/assert@^1" }, specifier: "@std/assert" },
    { code: { specifier: "jsr:@std/path@^1" }, specifier: "@std/path" },
  ],
  local: "/repo/src/index.ts",
  specifier: "./src/index.ts",
};

/** The graph for an entry whose only bare imports are jsr packages, as
 * `deno info` prints it: a package's modules sit under `https://jsr.io`, and
 * one module can still carry a `jsr:` specifier. Each cache file has a
 * hashed, extensionless name. */
const stdPathGraph: InfoJson = {
  modules: [
    stdPathEntry,
    {
      local:
        "/home/me/.cache/deno/remote/registry.jsr.io/0f41a4f68c5d54f3d1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708",
      specifier: "jsr:/@std/path@1.1.0",
    },
    {
      local:
        "/home/me/.cache/deno/remote/https/jsr.io/7f8bdf473357ce1073604294edb7c766453362241a4c62d236b3fb7f58e6e81c",
      specifier: "https://jsr.io/@std/assert/1.0.19/mod.ts",
    },
  ],
  redirects: {
    "jsr:@std/assert@^1": "https://jsr.io/@std/assert/1.0.19/mod.ts",
    "jsr:@std/path@^1": "jsr:/@std/path@1.1.0",
  },
};

/** The graph for an entry that imports a repository file through its bare
 * specifier. The argument is the `local` path the file's module reports, or
 * null when the graph names no file. */
const vendorGraph = (vendorLocal: string | null): InfoJson => ({
  modules: [
    {
      dependencies: [
        {
          code: { specifier: "file:///repo/src/vendor.ts" },
          specifier: "vendor",
        },
      ],
      local: "/repo/src/index.ts",
      specifier: "./src/index.ts",
    },
    { local: vendorLocal, specifier: "file:///repo/src/vendor.ts" },
  ],
});

/** The graph for an entry that imports an extensionless subpath of a
 * package that names no export map: the compiler enters the folder the
 * subpath names on its own. */
const valibotSubpathGraph: InfoJson = {
  ...valibotGraph,
  modules: [
    {
      local: null,
      npmPackage: "valibot@1.4.1",
      specifier: "npm:/valibot@1.4.1/lib",
    },
    entryImportingValibotByCode,
  ],
  redirects: { "npm:valibot@^1.4.1": "npm:/valibot@1.4.1/lib" },
};

describe("paths from deno info", () => {
  test("maps a bare npm specifier to its cached package folder", () => {
    expect(
      pathsFromAFilledCache(valibotGraph, "/home/me/.cache/deno/npm"),
    ).toEqual({
      valibot: ["/home/me/.cache/deno/npm/registry.npmjs.org/valibot/1.4.1"],
    });
  });

  test("maps a type-only dependency the same way", () => {
    const graph: InfoJson = {
      ...valibotGraph,
      modules: [
        valibotModule,
        {
          dependencies: [
            { specifier: "valibot", type: { specifier: "npm:valibot@^1.4.1" } },
          ],
          local: "/repo/src/index.ts",
          specifier: "./src/index.ts",
        },
      ],
    };
    expect(pathsFromAFilledCache(graph, "/home/me/.cache/deno/npm")).toEqual({
      valibot: ["/home/me/.cache/deno/npm/registry.npmjs.org/valibot/1.4.1"],
    });
  });

  test("leaves a bare jsr specifier unmapped", () => {
    expect(
      pathsFromInfo(stdPathGraph, "/home/me/.cache/deno/npm", noExportMaps),
    ).toEqual({});
  });

  test("answers nothing when the graph names no file for the module", () => {
    expect(
      pathsFromInfo(
        vendorGraph(null),
        "/home/me/.cache/deno/npm",
        noExportMaps,
      ),
    ).toEqual({});
  });

  test("maps a bare specifier to a repository file", () => {
    expect(
      pathsFromInfo(
        vendorGraph("/repo/src/vendor.ts"),
        "/home/me/.cache/deno/npm",
        noExportMaps,
      ),
    ).toEqual({ vendor: ["/repo/src/vendor.ts"] });
  });

  test("keeps the specifiers the compiler already resolves out", () => {
    const graph: InfoJson = {
      modules: [
        {
          dependencies: [
            {
              code: { specifier: "https:/example.com/mod.ts" },
              specifier: "https://example.com/mod.ts",
            },
            {
              code: { specifier: "jsr:/@std/path@1.1.0" },
              specifier: "jsr:@std/path",
            },
            { code: { specifier: "node:fs" }, specifier: "node:fs" },
            {
              code: { specifier: "./src/shared/db/client.ts" },
              specifier: "#shared/db/client.ts",
            },
            { code: { specifier: "./mod.ts" }, specifier: "./mod.ts" },
            { code: { specifier: "/abs/mod.ts" }, specifier: "/abs/mod.ts" },
          ],
          local: "/repo/src/index.ts",
          specifier: "./src/index.ts",
        },
        {
          local: "/cache/https/example.com/mod.ts",
          specifier: "https:/example.com/mod.ts",
        },
        {
          local: "/cache/jsr/path.ts",
          specifier: "jsr:/@std/path@1.1.0",
        },
        { local: null, specifier: "node:fs" },
        {
          local: "/repo/src/shared/db/client.ts",
          specifier: "./src/shared/db/client.ts",
        },
        { local: "/repo/mod.ts", specifier: "./mod.ts" },
        { local: "/abs/mod.ts", specifier: "/abs/mod.ts" },
      ],
    };
    expect(pathsFromInfo(graph, "/cache/npm", noExportMaps)).toEqual({});
  });

  test("keeps the first answer for a specifier the graph resolves twice", () => {
    const graph: InfoJson = {
      modules: [
        valibotModule,
        {
          local: null,
          npmPackage: "valibot@1.4.0",
          specifier: "npm:/valibot@1.4.0",
        },
        {
          dependencies: [
            { code: { specifier: "npm:valibot@^1.4.1" }, specifier: "valibot" },
          ],
          local: "/repo/src/index.ts",
          specifier: "./src/index.ts",
        },
        {
          dependencies: [
            { code: { specifier: "npm:valibot@^1.3.0" }, specifier: "valibot" },
          ],
          local: "/repo/src/other.ts",
          specifier: "./src/other.ts",
        },
      ],
      npmPackages: {
        "valibot@1.4.0": {
          name: "valibot",
          registryUrl: "https://registry.npmjs.org/",
          version: "1.4.0",
        },
        "valibot@1.4.1": {
          name: "valibot",
          registryUrl: "https://registry.npmjs.org/",
          version: "1.4.1",
        },
      },
      redirects: {
        "npm:valibot@^1.3.0": "npm:/valibot@1.4.0",
        "npm:valibot@^1.4.1": "npm:/valibot@1.4.1",
      },
    };
    expect(pathsFromAFilledCache(graph, "/cache/npm")).toEqual({
      valibot: ["/cache/npm/registry.npmjs.org/valibot/1.4.1"],
    });
  });

  test("answers nothing for a dependency with no code and no type", () => {
    const graph: InfoJson = {
      ...valibotGraph,
      modules: [
        valibotModule,
        {
          dependencies: [{ specifier: "valibot" }],
          local: "/repo/src/index.ts",
          specifier: "./src/index.ts",
        },
      ],
    };
    expect(
      pathsFromInfo(graph, "/home/me/.cache/deno/npm", noExportMaps),
    ).toEqual({});
  });

  test("answers nothing for a dependency written with no specifier", () => {
    const graph: InfoJson = {
      ...valibotGraph,
      modules: [
        valibotModule,
        {
          dependencies: [{ code: { specifier: "npm:valibot@^1.4.1" } }],
          local: "/repo/src/index.ts",
          specifier: "./src/index.ts",
        },
      ],
    };
    expect(
      pathsFromInfo(graph, "/home/me/.cache/deno/npm", noExportMaps),
    ).toEqual({});
  });

  test("answers nothing when the graph names no npm package entry", () => {
    expect(
      pathsFromInfo(
        { ...valibotGraph, npmPackages: {} },
        "/home/me/.cache/deno/npm",
        noExportMaps,
      ),
    ).toEqual({});
  });

  test("answers an empty mapping when the graph holds no dependencies", () => {
    expect(pathsFromInfo({}, "/home/me/.cache/deno/npm", noExportMaps)).toEqual(
      {},
    );
    expect(
      pathsFromInfo(
        { modules: [{ local: null, specifier: "./src/index.ts" }] },
        "/home/me/.cache/deno/npm",
        noExportMaps,
      ),
    ).toEqual({});
  });

  test("keeps the package folder for a peer variant the graph names by version", () => {
    const graph: InfoJson = {
      ...valibotGraph,
      modules: [
        {
          local: null,
          npmPackage: "valibot@1.4.1_typescript@5.9.2",
          specifier: "npm:/valibot@1.4.1",
        },
        entryImportingValibotByCode,
      ],
      npmPackages: {
        "valibot@1.4.1_typescript@5.9.2": {
          name: "valibot",
          registryUrl: "https://registry.npmjs.org/",
          version: "1.4.1",
        },
      },
    };
    expect(pathsFromAFilledCache(graph, "/home/me/.cache/deno/npm")).toEqual({
      valibot: ["/home/me/.cache/deno/npm/registry.npmjs.org/valibot/1.4.1"],
    });
  });

  test("raises when the graph module does not sit under its package", () => {
    const graph: InfoJson = {
      ...valibotGraph,
      modules: [
        {
          local: null,
          npmPackage: "valibot@1.4.1_typescript@5.9.2",
          specifier: "npm:/other@2.0.0",
        },
        {
          dependencies: [
            {
              code: { specifier: "npm:/other@2.0.0" },
              specifier: "valibot",
            },
          ],
          local: "/repo/src/index.ts",
          specifier: "./src/index.ts",
        },
      ],
      npmPackages: {
        "valibot@1.4.1_typescript@5.9.2": {
          name: "valibot",
          registryUrl: "https://registry.npmjs.org/",
          version: "1.4.1",
        },
      },
    };
    expect(() =>
      pathsFromInfo(graph, "/home/me/.cache/deno/npm", noExportMaps),
    ).toThrow("npm:/other@2.0.0 does not sit under npm:/valibot@1.4.1");
  });

  test("says so when the cache holds no package folder", () => {
    expect(() =>
      pathsFromInfo(
        valibotGraph,
        "/home/me/.cache/deno/npm",
        noExportMaps,
        undefined,
        holdsNoFolder,
      ),
    ).toThrow(
      "The graph resolves npm:/valibot@1.4.1 to " +
        "/home/me/.cache/deno/npm/registry.npmjs.org/valibot/1.4.1, and the cache holds no such folder",
    );
  });

  test("accepts a directory subpath of a package that names no export map", () => {
    expect(
      pathsFromInfo(
        valibotSubpathGraph,
        "/home/me/.cache/deno/npm",
        noExportMaps,
        undefined,
        (path) => path.endsWith("/lib"),
      ),
    ).toEqual({
      valibot: [
        "/home/me/.cache/deno/npm/registry.npmjs.org/valibot/1.4.1/lib",
      ],
    });
  });

  test("says so when an unmapped subpath names no file and no folder", () => {
    expect(() =>
      pathsFromInfo(
        valibotSubpathGraph,
        "/home/me/.cache/deno/npm",
        noExportMaps,
        undefined,
        holdsNoFolder,
      ),
    ).toThrow(
      "The cached package at " +
        "/home/me/.cache/deno/npm/registry.npmjs.org/valibot/1.4.1 resolves its /lib to " +
        "/home/me/.cache/deno/npm/registry.npmjs.org/valibot/1.4.1/lib, and the cache holds no such file or folder",
    );
  });
});

describe("bare paths of a repository", () => {
  test("answers no mapping when the repository has no entry", async () => {
    const root = await Deno.makeTempDir({ prefix: "unread-fields-bare-" });
    try {
      await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({}));
      expect(await barePaths(root, "./src/index.ts")).toEqual({});
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("raises when the entry's graph cannot resolve", async () => {
    const root = await Deno.makeTempDir({ prefix: "unread-fields-broken-" });
    try {
      await Deno.mkdir(`${root}/src`);
      // A workspace member that is not there leaves `deno info` with a
      // configuration it cannot resolve, and the scan says so instead of
      // reporting nothing.
      await Deno.writeTextFile(
        `${root}/deno.json`,
        JSON.stringify({ workspace: ["./nowhere/"] }),
      );
      await Deno.writeTextFile(`${root}/src/index.ts`, "export {};\n");
      await expect(barePaths(root, "./src/index.ts")).rejects.toThrow(
        "deno info",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
