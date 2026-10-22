import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { scanUnreadFields } from "#scripts/unread-fields/scan.ts";

/**
 * Which folders the scan reads, whether a mention takes the value out, and
 * where the reader lives.
 */
describe("the folders the scan reads", () => {
  test("refuses a repository with no src folder", async () => {
    // A run that says every one of no fields is read reads like a clean bill,
    // so a checkout without the folder the report is about has to fail.
    const root = await Deno.makeTempDir({ prefix: "unread-fields-bare-" });
    await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({}));
    try {
      await expect(scanUnreadFields(root)).rejects.toThrow("has no src folder");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("refuses a repository whose src folder holds no source file", async () => {
    // The same reason as above: zero fields, every one of them read. An
    // empty folder passes the folder check, so the file count has to fail.
    const root = await Deno.makeTempDir({ prefix: "unread-fields-empty-" });
    await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({}));
    await Deno.mkdir(`${root}/src`);
    try {
      await expect(scanUnreadFields(root)).rejects.toThrow(
        "holds no source file",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("scans a repository whose deno.json has no import map", async () => {
    // Most Deno repositories declare no aliases at all. One of those has
    // nothing to translate, and the scan reads it like any other.
    const root = await Deno.makeTempDir({ prefix: "unread-fields-noimp-" });
    try {
      await Deno.mkdir(`${root}/src`);
      await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({}));
      await Deno.writeTextFile(
        `${root}/src/shapes.ts`,
        "export interface Sum { total: number }\n",
      );
      const found = await scanUnreadFields(root);
      expect(found.map((f) => `${f.owner}.${f.field}`)).toEqual(["Sum.total"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("sees a field a plain .js reader takes out", async () => {
    // A browser script the bundle builds from plain .js is a reader too. A
    // walk that loads only .ts files would call its reads nothing.
    const root = await Deno.makeTempDir({ prefix: "unread-fields-jsread-" });
    try {
      await Deno.mkdir(`${root}/src`);
      await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({}));
      await Deno.writeTextFile(
        `${root}/src/shapes.ts`,
        "export interface Sum { total: number }\n",
      );
      await Deno.writeTextFile(
        `${root}/src/produce.ts`,
        "import type { Sum } from './shapes.ts';\n\nexport const sum: Sum = { total: 1 };\n",
      );
      await Deno.writeTextFile(
        `${root}/src/jsreader.js`,
        "import { sum } from './produce.ts';\n\nexport const read = sum.total;\n",
      );
      const found = await scanUnreadFields(root);
      expect(found.map((f) => `${f.owner}.${f.field}:${f.verdict}`)).toEqual([
        "Sum.total:read",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
describe("the shapes a bare specifier holds", () => {
  /** The source both valibot fixtures scan: a shape the package's own types
   * decide, written against a bare import. */
  const intentSource = [
    'import { type InferOutput, number, object, string } from "valibot";',
    "",
    "const IntentSchema = object({ name: string(), count: number() });",
    "",
    "export type Intent = InferOutput<typeof IntentSchema>;",
  ];

  /** The fields the scan reports for a repository whose import map carries
   * one specifier of the root import map, and whose entry holds the source.
   * The package warms the cache first, so the child `deno info` resolves the
   * specifier the way a scan of this repository does. The warmer cannot be a
   * static import: it runs when the test does, and its whole job is to have
   * the package cached before the child resolves it. The fixture pins no
   * version of its own: it reads the root import map. */
  const fieldsOfFixture = async (
    name: string,
    source: readonly string[],
    entry: { exports: unknown; file: string } = {
      exports: "./src/index.ts",
      file: "src/index.ts",
    },
  ): Promise<string[]> => {
    await import(name);
    const repoRoot = fromFileUrl(new URL("../../../", import.meta.url)).replace(
      /\/$/,
      "",
    );
    const repoConfig = JSON.parse(
      await Deno.readTextFile(`${repoRoot}/deno.json`),
    );
    const specifier = repoConfig.imports?.[name];
    if (typeof specifier !== "string") {
      throw new Error(`deno.json maps no ${name} import`);
    }
    const root = await Deno.makeTempDir({ prefix: "unread-fields-fixture-" });
    try {
      await Deno.mkdir(`${root}/src`);
      await Deno.writeTextFile(
        `${root}/deno.json`,
        JSON.stringify({
          exports: entry.exports,
          imports: { [name]: specifier },
        }),
      );
      await Deno.writeTextFile(
        `${root}/${entry.file}`,
        [...source, ""].join("\n"),
      );
      const found = await scanUnreadFields(root);
      return found.map((f) => `${f.owner}.${f.field}`).sort();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  };

  test("reports the fields of a valibot shape", async () => {
    // Issue #2214: a bare import such as valibot resolved to `any`, so a
    // shape written with `InferOutput` reported zero fields. The mapping from
    // `deno info` gives the compiler the package's real types.
    expect(await fieldsOfFixture("valibot", intentSource)).toEqual([
      "Intent.count",
      "Intent.name",
    ]);
  });

  test("reports the fields when the entry is the root entry of a map", async () => {
    // Deno accepts the entry as a map, `{ ".": "./src/main.ts" }`, as well
    // as a string. An entry lookup that reads only the string falls back to
    // the usual file, the bare imports stay unmapped, and the shapes they
    // hold drop out of the report in silence.
    expect(
      await fieldsOfFixture("valibot", intentSource, {
        exports: { ".": "./src/main.ts" },
        file: "src/main.ts",
      }),
    ).toEqual(["Intent.count", "Intent.name"]);
  });

  test("reports the fields whose shape a subpath import's types decide", async () => {
    // `@libsql/core/config` is one of the subpath imports the repository
    // writes. The package publishes only lib-esm and lib-cjs, and its export
    // map sends the subpath to lib-esm/config.d.ts. A mapping at the subpath
    // itself names no file, the import resolved to `any`, and the shape the
    // conditional names stayed out of the report.
    //
    // The scan reports the fields the repository writes, so the conditional
    // is what lets the package's own types decide which written shape the
    // alias holds.
    expect(
      await fieldsOfFixture("@libsql/core/config", [
        'import { type ExpandedConfig } from "@libsql/core/config";',
        "",
        "export type Held = ExpandedConfig extends { concurrency: number }",
        "  ? { resolved: true }",
        "  : { unresolved: true };",
      ]),
    ).toEqual(["Held.resolved"]);
  });
});
