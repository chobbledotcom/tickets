import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { jsSiblingPath, runCommand } from "#scripts/sentry-debug-ids/run.ts";

const BUNDLE = "code;\n//# sourceMappingURL=bundle.ts.map";
const MAP = '{"version":3,"sources":[],"mappings":""}';

describe("sentry debug ids", () => {
  let dir: string;
  let bundle: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    bundle = `${dir}/bundle.ts`;
    await Deno.writeTextFile(bundle, BUNDLE);
    await Deno.writeTextFile(`${bundle}.map`, MAP);
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  describe("jsSiblingPath", () => {
    // The Sentry CLI injects debug ids only into files it reads as JavaScript,
    // and prints "Nothing to inject" for anything else.
    test("swaps a TypeScript bundle name for a JavaScript one", () => {
      expect(jsSiblingPath("bunny-script.ts")).toBe("bunny-script.js");
    });

    test("keeps a path that is already JavaScript", () => {
      expect(jsSiblingPath("bundle.js")).toBe("bundle.js");
    });

    test("only strips a trailing extension", () => {
      expect(jsSiblingPath("dist/v2.ts.build.ts")).toBe("dist/v2.ts.build.js");
    });
  });

  describe("prepare", () => {
    test("writes a JavaScript copy of the bundle and its map", async () => {
      await runCommand("prepare", bundle);

      expect(await Deno.readTextFile(`${dir}/bundle.js`)).toContain("code;");
      expect(await Deno.readTextFile(`${dir}/bundle.js.map`)).toBe(MAP);
    });

    // The CLI finds the map to stamp by following this link. Pointing it at the
    // TypeScript map leaves the map without a debug id, and an uploaded map
    // with no debug id never matches an event.
    test("points the copy at its own map, by name and not by path", async () => {
      await runCommand("prepare", bundle);

      expect(await Deno.readTextFile(`${dir}/bundle.js`)).toContain(
        "//# sourceMappingURL=bundle.js.map",
      );
    });
  });

  describe("adopt", () => {
    test("copies the injected code back onto the deployed bundle", async () => {
      await runCommand("prepare", bundle);
      await Deno.writeTextFile(
        `${dir}/bundle.js`,
        "code;\n//# sourceMappingURL=bundle.js.map\n//# debugId=abc",
      );
      await Deno.writeTextFile(`${dir}/bundle.js.map`, '{"debug_id":"abc"}');

      await runCommand("adopt", bundle);

      const deployed = await Deno.readTextFile(bundle);
      expect(deployed).toContain("//# debugId=abc");
      expect(deployed).toContain("//# sourceMappingURL=bundle.ts.map");
      expect(await Deno.readTextFile(`${bundle}.map`)).toBe(
        '{"debug_id":"abc"}',
      );
    });
  });

  describe("runCommand", () => {
    test("names the JavaScript copy without touching a file", async () => {
      expect(await runCommand("js-path", bundle)).toBe(`${dir}/bundle.js`);
      await expect(Deno.stat(`${dir}/bundle.js`)).rejects.toThrow();
    });

    test("returns the path each command worked on", async () => {
      expect(await runCommand("prepare", bundle)).toBe(`${dir}/bundle.js`);
      expect(await runCommand("adopt", bundle)).toBe(`${dir}/bundle.js`);
    });

    test("refuses a command it does not know", async () => {
      await expect(runCommand("upload", bundle)).rejects.toThrow(
        'Unknown command "upload"',
      );
    });
  });
});
