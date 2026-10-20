import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  barePaths,
  type InfoJson,
  type InfoModule,
  pathsFromInfo,
} from "#scripts/unread-fields/bare-paths.ts";

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

/** The entry module of the graph for an entry whose only bare import is a
 * jsr package. */
const stdPathEntry = {
  dependencies: [
    { code: { specifier: "jsr:@std/path@^1" }, specifier: "@std/path" },
  ],
  local: "/repo/src/index.ts",
  specifier: "./src/index.ts",
};

/** The graph for an entry whose only bare import is a jsr package. */
const stdPathGraph: InfoJson = {
  modules: [
    stdPathEntry,
    {
      local: "/home/me/.cache/deno/remote/http+jsr.io/@std/path/1.1.0/mod.ts",
      specifier: "jsr:/@std/path@1.1.0",
    },
  ],
  redirects: { "jsr:@std/path@^1": "jsr:/@std/path@1.1.0" },
};

describe("paths from deno info", () => {
  test("maps a bare npm specifier to its cached package folder", () => {
    expect(pathsFromInfo(valibotGraph, "/home/me/.cache/deno/npm")).toEqual({
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
    expect(pathsFromInfo(graph, "/home/me/.cache/deno/npm")).toEqual({
      valibot: ["/home/me/.cache/deno/npm/registry.npmjs.org/valibot/1.4.1"],
    });
  });

  test("maps a bare jsr specifier to its cached file", () => {
    expect(pathsFromInfo(stdPathGraph, "/home/me/.cache/deno/npm")).toEqual({
      "@std/path": [
        "/home/me/.cache/deno/remote/http+jsr.io/@std/path/1.1.0/mod.ts",
      ],
    });
  });

  test("answers nothing when the graph names no file for the module", () => {
    const graph: InfoJson = {
      ...stdPathGraph,
      modules: [
        stdPathEntry,
        { local: null, specifier: "jsr:/@std/path@1.1.0" },
      ],
    };
    expect(pathsFromInfo(graph, "/home/me/.cache/deno/npm")).toEqual({});
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
    expect(pathsFromInfo(graph, "/cache/npm")).toEqual({});
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
    expect(pathsFromInfo(graph, "/cache/npm")).toEqual({
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
    expect(pathsFromInfo(graph, "/home/me/.cache/deno/npm")).toEqual({});
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
    expect(pathsFromInfo(graph, "/home/me/.cache/deno/npm")).toEqual({});
  });

  test("answers nothing when the graph names no npm package entry", () => {
    expect(
      pathsFromInfo(
        { ...valibotGraph, npmPackages: {} },
        "/home/me/.cache/deno/npm",
      ),
    ).toEqual({});
  });

  test("answers an empty mapping when the graph holds no dependencies", () => {
    expect(pathsFromInfo({}, "/home/me/.cache/deno/npm")).toEqual({});
    expect(
      pathsFromInfo(
        { modules: [{ local: null, specifier: "./src/index.ts" }] },
        "/home/me/.cache/deno/npm",
      ),
    ).toEqual({});
  });

  test("maps a bare npm subpath to its file in the package folder", () => {
    const graph: InfoJson = {
      modules: [
        {
          local: null,
          npmPackage: "@jsquash/jpeg@1.6.0",
          specifier: "npm:/@jsquash/jpeg@1.6.0/decode.js",
        },
        {
          dependencies: [
            {
              code: { specifier: "npm:/@jsquash/jpeg@^1.5.0/decode.js" },
              specifier: "@jsquash/jpeg/decode.js",
            },
          ],
          local: "/repo/src/image.ts",
          specifier: "./src/image.ts",
        },
      ],
      npmPackages: {
        "@jsquash/jpeg@1.6.0": {
          name: "@jsquash/jpeg",
          registryUrl: "https://registry.npmjs.org/",
          version: "1.6.0",
        },
      },
      redirects: {
        "npm:/@jsquash/jpeg@^1.5.0/decode.js":
          "npm:/@jsquash/jpeg@1.6.0/decode.js",
      },
    };
    expect(pathsFromInfo(graph, "/home/me/.cache/deno/npm")).toEqual({
      "@jsquash/jpeg/decode.js": [
        "/home/me/.cache/deno/npm/registry.npmjs.org/@jsquash/jpeg/1.6.0/decode.js",
      ],
    });
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
    expect(pathsFromInfo(graph, "/home/me/.cache/deno/npm")).toEqual({
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
    expect(() => pathsFromInfo(graph, "/home/me/.cache/deno/npm")).toThrow(
      "npm:/other@2.0.0 does not sit under npm:/valibot@1.4.1",
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
