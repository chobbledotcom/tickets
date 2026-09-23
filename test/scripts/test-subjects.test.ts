import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  cachingReader,
  collectTestSubjects,
  resolveProjectImportOrNull,
} from "#scripts/test-subjects.ts";

const IMPORT_MAP = {
  "#cli/": "./cli/",
  "#db/": "./src/shared/db/",
  "#fp": "./src/fp.ts",
  "#routes": "./src/features/index.ts",
  "#routes/": "./src/features/",
  "#scripts/": "./scripts/",
  "#shared/": "./src/shared/",
  "#test-utils/": "./test/test-utils/",
  "#test/": "./test/",
  "#ui/": "./src/ui/",
  // A non-alias key that still points into src: only `#` specifiers count.
  "legacy/": "./src/legacy/",
};

/** Run the subject walk over an in-memory tree. */
const walkTree = (files: Record<string, string>, testFile: string) =>
  collectTestSubjects(
    testFile,
    readerFor(files),
    IMPORT_MAP,
    testTreeOf(files),
  );

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

    test("resolves an alias that points at a tooling script", () => {
      expect(
        resolveProjectImportOrNull(
          "#scripts/path.ts",
          IMPORT_MAP,
          "test/scripts/path.test.ts",
        ),
      ).toBe("scripts/path.ts");
    });

    test("resolves an alias that points at a command-line entry", () => {
      expect(
        resolveProjectImportOrNull(
          "#cli/backup.ts",
          IMPORT_MAP,
          "test/scripts/backup.test.ts",
        ),
      ).toBe("cli/backup.ts");
    });

    test("ignores a bare import-map key that is not a # alias", () => {
      expect(
        resolveProjectImportOrNull(
          "legacy/thing.ts",
          IMPORT_MAP,
          "test/shared/a.test.ts",
        ),
      ).toBeNull();
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
      expect(
        (await walkTree(files, "test/shared/csrf.test.ts")).subjects,
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
      expect(
        (
          await walkTree(files, "test/ui/table/component.test.tsx")
        ).subjects.sort(),
      ).toEqual(["src/shared/csrf.ts", "src/ui/templates/table/component.tsx"]);
    });

    test("names no subject for what a test-utils helper reaches", async () => {
      // Shared helpers under test/test-utils/ are plumbing nearly every test
      // needs — a database row, a config value — so nothing they import says
      // what the test is about.
      const files = {
        "test/shared/email.test.ts": [
          `import { sendEmail } from "#shared/email.ts";`,
          `import { describeWithEnv } from "#test-utils/db.ts";`,
        ].join("\n"),
        "test/test-utils/db.ts": [
          `import { getDb } from "#db/client.ts";`,
          `import { withEnv } from "#test-utils/env.ts";`,
        ].join("\n"),
        "test/test-utils/env.ts": `import { config } from "#shared/config.ts";`,
      };
      expect(
        (await walkTree(files, "test/shared/email.test.ts")).subjects,
      ).toEqual(["src/shared/email.ts"]);
    });

    test("follows helpers through more than one hop", async () => {
      const files = {
        "test/a.test.ts": `import { one } from "#test/first.ts";`,
        "test/first.ts": `import { two } from "#test/second.ts";`,
        "test/second.ts": `import { deep } from "#shared/deep.ts";`,
      };
      expect((await walkTree(files, "test/a.test.ts")).subjects).toEqual([
        "src/shared/deep.ts",
      ]);
    });

    test("does not follow a source's own imports", async () => {
      const files = {
        // Never read: following it would make every test exercise the tree.
        "src/shared/a.ts": `import { b } from "#shared/b.ts";`,
        "test/shared/a.test.ts": `import { a } from "#shared/a.ts";`,
      };
      expect((await walkTree(files, "test/shared/a.test.ts")).subjects).toEqual(
        ["src/shared/a.ts"],
      );
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
      expect((await walkTree(files, "test/a.test.ts")).subjects).toEqual([
        "src/shared/a.ts",
      ]);
    });

    test("reports no subjects for a test that imports nothing of ours", async () => {
      const files = {
        "test/pure.test.ts": `import { expect } from "@std/expect";`,
      };
      expect((await walkTree(files, "test/pure.test.ts")).subjects).toEqual([]);
    });

    test("marks a test app-loading when a helper reaches the app entry", async () => {
      // A suite that drives pages through session.ts is an integration suite
      // however it reaches the app — the misplaced-test list must not move it
      // onto the mirror of an import it only checks along the way (issue
      // #2312).
      const files = {
        "test/features/maintenance.test.ts": [
          `import { resetDb } from "#test-utils/db.ts";`,
          `import { adminFormPost } from "#test-utils/session.ts";`,
        ].join("\n"),
        "test/test-utils/db.ts": `import { getDb } from "#db/client.ts";`,
        "test/test-utils/mocks.ts": `import { handleRequest } from "#routes";`,
        "test/test-utils/session.ts": `import { awaitTestRequest } from "#test-utils/mocks.ts";`,
      };
      const walked = await walkTree(files, "test/features/maintenance.test.ts");
      expect(walked.loadsApp).toBe(true);
      expect(walked.subjects).toEqual([]);
    });

    test("marks a test app-loading when a helper reaches a route module", async () => {
      const files = {
        "test/features/maintenance.test.ts": `import { postSetting } from "#test-utils/session.ts";`,
        "test/test-utils/session.ts": `const { handleRequest } = await import("#routes/admin/settings.ts");`,
      };
      expect(
        (await walkTree(files, "test/features/maintenance.test.ts")).loadsApp,
      ).toBe(true);
    });

    test("keeps a route module the test imports itself a plain subject", async () => {
      // The test file's own import names its subject on purpose, so it stays
      // a move candidate — only a helper's reach makes a test integration.
      const files = {
        "test/ui/templates/checkin/routes.test.ts": `const { routeCheckin } = await import("#routes/checkin.ts");`,
      };
      const walked = await walkTree(
        files,
        "test/ui/templates/checkin/routes.test.ts",
      );
      expect(walked.subjects).toEqual(["src/features/checkin.ts"]);
      expect(walked.loadsApp).toBe(false);
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
