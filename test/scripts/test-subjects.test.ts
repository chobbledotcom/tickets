import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  cachingReader,
  collectTestSubjects,
  resolveProjectImportOrNull,
} from "#scripts/test-subjects.ts";

const IMPORT_MAP = {
  "#fp": "./src/fp.ts",
  "#shared/": "./src/shared/",
  "#test-utils/": "./test/test-utils/",
  "#test/": "./test/",
  "#ui/": "./src/ui/",
};

/** Reads from an in-memory tree; an unknown path throws, as a real read would. */
const readerFor =
  (files: Record<string, string>) =>
  (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) throw new Error(`No such file: ${path}`);
    return Promise.resolve(text);
  };

/** The test-tree paths of an in-memory file set — what the walk may follow. */
const testTreeOf = (files: Record<string, string>): Set<string> =>
  new Set(Object.keys(files).filter((path) => path.startsWith("test/")));

describe("test subjects", () => {
  describe("resolveProjectImportOrNull", () => {
    test("resolves a directory alias to its target path", () => {
      expect(
        resolveProjectImportOrNull(
          "#shared/csrf.ts",
          IMPORT_MAP,
          "test/shared/csrf.test.ts",
        ),
      ).toBe("src/shared/csrf.ts");
    });

    test("resolves an exact alias to the whole target", () => {
      expect(
        resolveProjectImportOrNull("#fp", IMPORT_MAP, "test/fp.test.ts"),
      ).toBe("src/fp.ts");
    });

    test("resolves an alias that points into the test tree", () => {
      expect(
        resolveProjectImportOrNull(
          "#test/ui/shared.ts",
          IMPORT_MAP,
          "test/shared/a.test.ts",
        ),
      ).toBe("test/ui/shared.ts");
    });

    test("resolves a sibling relative import against the importing file", () => {
      expect(
        resolveProjectImportOrNull(
          "./helpers.ts",
          IMPORT_MAP,
          "test/shared/merge/cleanup.test.ts",
        ),
      ).toBe("test/shared/merge/helpers.ts");
    });

    test("walks up for a parent relative import", () => {
      expect(
        resolveProjectImportOrNull(
          "../../shared.ts",
          IMPORT_MAP,
          "test/ui/templates/table/component.test.tsx",
        ),
      ).toBe("test/ui/shared.ts");
    });

    test("returns null for a module outside the project", () => {
      expect(
        resolveProjectImportOrNull(
          "@std/expect",
          IMPORT_MAP,
          "test/shared/a.test.ts",
        ),
      ).toBeNull();
    });

    test("returns null for an alias the import map does not define", () => {
      expect(
        resolveProjectImportOrNull(
          "#nope/thing.ts",
          IMPORT_MAP,
          "test/shared/a.test.ts",
        ),
      ).toBeNull();
    });
  });

  describe("collectTestSubjects", () => {
    test("collects the sources the test imports itself", async () => {
      const files = {
        "test/shared/csrf.test.ts": `import { signCsrf } from "#shared/csrf.ts";`,
      };
      const read = readerFor(files);
      expect(
        await collectTestSubjects(
          "test/shared/csrf.test.ts",
          read,
          IMPORT_MAP,
          testTreeOf(files),
        ),
      ).toEqual(["src/shared/csrf.ts"]);
    });

    test("collects the source a shared helper imports on the test's behalf", async () => {
      const files = {
        "test/ui/table/component.test.tsx": [
          `import { getCurrentCsrfToken } from "#shared/csrf.ts";`,
          `import { render } from "./shared.ts";`,
        ].join("\n"),
        "test/ui/table/shared.ts": `import { AttendeeTable } from "#ui/templates/table/component.tsx";`,
      };
      const read = readerFor(files);
      expect(
        (
          await collectTestSubjects(
            "test/ui/table/component.test.tsx",
            read,
            IMPORT_MAP,
            testTreeOf(files),
          )
        ).sort(),
      ).toEqual(["src/shared/csrf.ts", "src/ui/templates/table/component.tsx"]);
    });

    test("follows helpers through more than one hop", async () => {
      const files = {
        "test/a.test.ts": `import { one } from "#test/first.ts";`,
        "test/first.ts": `import { two } from "#test/second.ts";`,
        "test/second.ts": `import { deep } from "#shared/deep.ts";`,
      };
      const read = readerFor(files);
      expect(
        await collectTestSubjects(
          "test/a.test.ts",
          read,
          IMPORT_MAP,
          testTreeOf(files),
        ),
      ).toEqual(["src/shared/deep.ts"]);
    });

    test("does not follow a source's own imports", async () => {
      const files = {
        // Never read: following it would make every test exercise the tree.
        "src/shared/a.ts": `import { b } from "#shared/b.ts";`,
        "test/shared/a.test.ts": `import { a } from "#shared/a.ts";`,
      };
      const read = readerFor(files);
      expect(
        await collectTestSubjects(
          "test/shared/a.test.ts",
          read,
          IMPORT_MAP,
          testTreeOf(files),
        ),
      ).toEqual(["src/shared/a.ts"]);
    });

    test("survives helpers that import each other in a cycle", async () => {
      const files = {
        "test/a.test.ts": `import { one } from "#test/first.ts";`,
        "test/first.ts": [
          `import { two } from "#test/second.ts";`,
          `import { a } from "#shared/a.ts";`,
        ].join("\n"),
        "test/second.ts": `import { one } from "#test/first.ts";`,
      };
      const read = readerFor(files);
      expect(
        await collectTestSubjects(
          "test/a.test.ts",
          read,
          IMPORT_MAP,
          testTreeOf(files),
        ),
      ).toEqual(["src/shared/a.ts"]);
    });

    test("reports no subjects for a test that imports nothing of ours", async () => {
      const files = {
        "test/pure.test.ts": `import { expect } from "@std/expect";`,
      };
      const read = readerFor(files);
      expect(
        await collectTestSubjects(
          "test/pure.test.ts",
          read,
          IMPORT_MAP,
          testTreeOf(files),
        ),
      ).toEqual([]);
    });
  });

  describe("cachingReader", () => {
    test("reads each path once however often it is asked for", async () => {
      const reads: string[] = [];
      const read = cachingReader((path) => {
        reads.push(path);
        return Promise.resolve(`text of ${path}`);
      });
      expect(await read("test/helpers.ts")).toBe("text of test/helpers.ts");
      expect(await read("test/helpers.ts")).toBe("text of test/helpers.ts");
      expect(await read("test/other.ts")).toBe("text of test/other.ts");
      expect(reads).toEqual(["test/helpers.ts", "test/other.ts"]);
    });
  });
});
