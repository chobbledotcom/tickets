import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  chainToEffect,
  moduleGraph,
  resolveSpecifierToFile,
  type SourceFile,
} from "#scripts/check-effects/graph.ts";

const ALIASES = [
  { name: "#io/", target: "./io/" },
  { name: "#types", target: "./types.ts" },
];

const walked = (files: readonly string[]): ReadonlySet<string> =>
  new Set(files);

const source = (file: string, content: string): SourceFile => ({
  content,
  file,
});

describe("specifier resolution", () => {
  test("resolves an alias specifier to its file", () => {
    expect(resolveSpecifierToFile("#io/db.ts", "any.ts", ALIASES)).toBe(
      "io/db.ts",
    );
    expect(resolveSpecifierToFile("#types", "any.ts", ALIASES)).toBe(
      "types.ts",
    );
  });

  test("resolves a relative specifier against the importing file", () => {
    expect(resolveSpecifierToFile("./helper.ts", "pure/core.ts", ALIASES)).toBe(
      "pure/helper.ts",
    );
    expect(resolveSpecifierToFile("../io/db.ts", "pure/core.ts", ALIASES)).toBe(
      "io/db.ts",
    );
  });

  test("leaves an external package or unknown alias unresolved", () => {
    expect(resolveSpecifierToFile("valibot", "pure/core.ts", ALIASES)).toBe(
      null,
    );
    expect(resolveSpecifierToFile("#nope/db.ts", "pure/core.ts", ALIASES)).toBe(
      null,
    );
  });
});

describe("module graph", () => {
  test("keeps static runtime imports and re-exports, and drops type-only ones", () => {
    const files = [
      source(
        "a.ts",
        [
          'import { x } from "./b.ts";',
          'import type { Y } from "./c.ts";',
          'export { x } from "./d.ts";',
          'export type { Z } from "./e.ts";',
          "",
        ].join("\n"),
      ),
      source("b.ts", "export const x = 1;"),
      source("c.ts", "export type Y = number;"),
      source("d.ts", "export const d = 1;"),
      source("e.ts", "export type Z = number;"),
    ];
    const graph = moduleGraph(
      files,
      ALIASES,
      walked(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]),
    );
    expect(graph.get("a.ts")).toEqual(["b.ts", "d.ts"]);
  });

  test("drops inline type-only imports and re-exports, keeps the rest", () => {
    const files = [
      source(
        "a.ts",
        [
          'import { type Y } from "./c.ts";',
          'import { type Z, type W } from "./e.ts";',
          'export { type V } from "./f.ts";',
          'import "./side.ts";',
          'import { type W, x } from "./b.ts";',
          "",
        ].join("\n"),
      ),
      source("b.ts", "export const x = 1;"),
      source("c.ts", "export type Y = number;"),
      source("side.ts", "export const side = 1;"),
      source("e.ts", "export type Z = number;"),
      source("f.ts", "export type V = number;"),
    ];
    const graph = moduleGraph(
      files,
      ALIASES,
      walked(["a.ts", "b.ts", "c.ts", "side.ts", "e.ts", "f.ts"]),
    );
    expect(graph.get("a.ts")).toEqual(["side.ts", "b.ts"]);
  });

  test("keeps literal dynamic imports and type-position ones never load", () => {
    const files = [
      source(
        "a.ts",
        [
          'const b = await import("./b.ts");',
          'type C = typeof import("./c.ts");',
          "export const a = b;",
          "",
        ].join("\n"),
      ),
      source("b.ts", "export const b = 1;"),
      source("c.ts", "export type C = number;"),
    ];
    const graph = moduleGraph(files, ALIASES, walked(["a.ts", "b.ts", "c.ts"]));
    expect(graph.get("a.ts")).toEqual(["b.ts"]);
  });

  test("resolves alias specifiers and drops files outside the walk", () => {
    const files = [
      source(
        "a.ts",
        'import { x } from "#io/store.ts";\nimport { y } from "./gone.ts";\n',
      ),
    ];
    const graph = moduleGraph(files, ALIASES, walked(["a.ts", "io/store.ts"]));
    expect(graph.get("a.ts")).toEqual(["io/store.ts"]);
  });
});

describe("chain to effect", () => {
  const graph = new Map<string, readonly string[]>([
    ["pure/leaky.ts", ["io/store.ts"]],
    ["io/store.ts", ["io/client.ts"]],
    ["io/client.ts", []],
    ["cycle/a.ts", ["cycle/b.ts"]],
    ["cycle/b.ts", ["cycle/a.ts"]],
  ]);

  test("answers null for a file outside the graph", () => {
    expect(
      chainToEffect(graph, new Set(["io/client.ts"]), "nowhere/else.ts"),
    ).toBe(null);
  });

  test("names only the file when the file is a root", () => {
    expect(
      chainToEffect(graph, new Set(["io/client.ts"]), "io/client.ts"),
    ).toEqual(["io/client.ts"]);
  });

  test("names every hop from the file to the root", () => {
    expect(
      chainToEffect(graph, new Set(["io/client.ts"]), "pure/leaky.ts"),
    ).toEqual(["pure/leaky.ts", "io/store.ts", "io/client.ts"]);
  });

  test("names a one-hop chain from a middle file to the root", () => {
    expect(
      chainToEffect(graph, new Set(["io/client.ts"]), "io/store.ts"),
    ).toEqual(["io/store.ts", "io/client.ts"]);
  });

  test("answers null when no root is reachable", () => {
    expect(
      chainToEffect(graph, new Set(["somewhere/else.ts"]), "pure/leaky.ts"),
    ).toBe(null);
  });

  test("walks a cycle without looping", () => {
    expect(chainToEffect(graph, new Set(["cycle/b.ts"]), "cycle/a.ts")).toEqual(
      ["cycle/a.ts", "cycle/b.ts"],
    );
  });
});
