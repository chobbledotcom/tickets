import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fileInputs } from "#scripts/static-assets/inputs.ts";

describe("file inputs", () => {
  test("keeps every module that is a file of the working copy", () => {
    expect(
      fileInputs([
        "src/ui/client/admin.ts",
        "../../.cache/deno/deno_esbuild/registry.npmjs.org/valibot@1.4.1/node_modules/valibot/dist/index.mjs",
      ]),
    ).toEqual([
      "src/ui/client/admin.ts",
      "../../.cache/deno/deno_esbuild/registry.npmjs.org/valibot@1.4.1/node_modules/valibot/dist/index.mjs",
    ]);
  });

  test("leaves out the modules the loader fetched as URLs", () => {
    // A jsr dependency arrives as a URL. It is not a file, so it cannot be
    // hashed against the working copy — the lockfile pins its version instead.
    expect(
      fileInputs([
        "https://jsr.io/@std/collections/1.2.0/mod.ts",
        "src/ui/client/admin.ts",
      ]),
    ).toEqual(["src/ui/client/admin.ts"]);
  });
});
