import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  answered,
  compilerOptions,
  pathIs,
  serviceHost,
  textOrNothing,
} from "#scripts/unread-fields/host.ts";

/** A path no repository has. The compiler probes shapes like this constantly,
 * so every helper here has to answer rather than fail. */
const NOWHERE = "/nowhere/at/all/probe.ts";

describe("the compiler's view of a repository", () => {
  let root = "";
  let file = "";

  beforeAll(async () => {
    root = await Deno.makeTempDir({ prefix: "unread-fields-host-" });
    file = `${root}/present.ts`;
    await Deno.writeTextFile(file, "export const total = 1;\n");
  });

  afterAll(async () => {
    await Deno.remove(root, { recursive: true });
  });

  describe("answered", () => {
    test("hands back what the compiler said", () => {
      expect(answered("a program", "program")).toBe("a program");
    });

    test("hands back a falsy answer the compiler gave on purpose", () => {
      expect(answered(0, "count")).toBe(0);
    });

    test("names what was missing when the compiler said nothing", () => {
      expect(() => answered(undefined, "program for the scan")).toThrow(
        "The compiler had no program for the scan",
      );
    });
  });

  describe("textOrNothing", () => {
    test("reads a file that is there", () => {
      expect(textOrNothing(file)).toBe("export const total = 1;\n");
    });

    test("answers nothing for a path that is not there", () => {
      expect(textOrNothing(NOWHERE)).toBeUndefined();
    });
  });

  describe("pathIs", () => {
    test("knows a file from a directory", () => {
      expect(pathIs("isFile")(file)).toBe(true);
      expect(pathIs("isDirectory")(file)).toBe(false);
    });

    test("knows a directory from a file", () => {
      expect(pathIs("isDirectory")(root)).toBe(true);
      expect(pathIs("isFile")(root)).toBe(false);
    });

    test("does not claim a path that is not there", () => {
      expect(pathIs("isFile")(NOWHERE)).toBe(false);
      expect(pathIs("isDirectory")(NOWHERE)).toBe(false);
    });
  });

  describe("serviceHost", () => {
    const hostFor = (): ReturnType<typeof serviceHost> =>
      serviceHost(root, [file], compilerOptions(root, {}));

    test("offers a snapshot of a file that is there", () => {
      const snapshot = hostFor().getScriptSnapshot(file);
      expect(snapshot?.getText(0, 6)).toBe("export");
    });

    test("offers no snapshot for a path that is not there", () => {
      expect(hostFor().getScriptSnapshot(NOWHERE)).toBeUndefined();
    });

    test("reads a file once and answers from memory after that", async () => {
      const host = hostFor();
      expect(host.readFile?.(file)).toBe("export const total = 1;\n");
      const gone = `${root}/fleeting.ts`;
      await Deno.writeTextFile(gone, "export const n = 2;\n");
      expect(host.readFile?.(gone)).toBe("export const n = 2;\n");
      await Deno.remove(gone);
      expect(host.readFile?.(gone)).toBe("export const n = 2;\n");
    });

    test("names the files the scan asked it to hold", () => {
      expect(hostFor().getScriptFileNames()).toEqual([file]);
    });

    test("hands back the options it was built with", () => {
      expect(hostFor().getCompilationSettings().baseUrl).toBe(root);
      expect(hostFor().getCurrentDirectory()).toBe(root);
    });

    test("finds the repository's own directories and files", () => {
      const host = hostFor();
      expect(host.directoryExists?.(root)).toBe(true);
      expect(host.fileExists?.(file)).toBe(true);
      expect(host.fileExists?.(NOWHERE)).toBe(false);
    });
  });
});
