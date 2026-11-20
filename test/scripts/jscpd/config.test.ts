import { isAbsolute, join, relative, resolve } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { COUNTS_PATH, readCounts } from "#scripts/jscpd/counts.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { directoryNames, pathExists } from "#test-utils/files.ts";

/** The directory that holds every scan config and the committed counts. */
const CONFIG_DIR = "cfg";

/** What one scan config promises. The test holds this table to the names in
 * `cfg/`, so a new scan must declare itself here. */
interface ScanPromise {
  /** The scan's name in `cfg/cpd-counts.json`, or null when it holds no count
   * and relies on jscpd's own exit code instead. */
  count: string | null;
  /** The scan skips the destructured dynamic imports that load a module on
   * first use. The scans of the tests and of their helpers read them. */
  skipsLazyImports: boolean;
  /** The scan treats names, literals and annotations as noise, so a renamed
   * copy is a clone. jscpd labels it `renamed`, and a `kind` filter would hide
   * it. */
  strict: boolean;
  /** The scan reads TypeScript, so it skips import and re-export statements. */
  typescript: boolean;
}

const LAZY_IMPORT_PATTERN =
  "(?m)^\\s*const\\s+\\{[^}]*\\}\\s*=\\s*await\\s+import\\([^)]*\\);";

const scans: Record<string, ScanPromise> = {
  "cfg/jscpd.css.json": {
    count: null,
    skipsLazyImports: false,
    strict: false,
    typescript: false,
  },
  "cfg/jscpd.helpers.json": {
    count: "helpers",
    skipsLazyImports: false,
    strict: true,
    typescript: true,
  },
  "cfg/jscpd.json": {
    count: "main",
    skipsLazyImports: true,
    strict: true,
    typescript: true,
  },
  "cfg/jscpd.renamed.json": {
    count: "renamed",
    skipsLazyImports: true,
    strict: false,
    typescript: true,
  },
  "cfg/jscpd.specs.json": {
    count: "specs",
    skipsLazyImports: true,
    strict: false,
    typescript: true,
  },
  "cfg/jscpd.support.json": {
    count: "support",
    skipsLazyImports: true,
    strict: true,
    typescript: true,
  },
  "cfg/jscpd.test.json": {
    count: "test",
    skipsLazyImports: false,
    strict: true,
    typescript: true,
  },
};

/** One scan's declared name and promise. */
const declaredScans = Object.entries(scans);

const readConfig = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Deno.readTextFile(join(projectRoot, name)));

/** The trees a scan reads, from the config's own `path` entries. jscpd resolves
 * them from the config's directory, so `../src` means `<root>/src`. */
const readScanPaths = async (name: string): Promise<string[]> =>
  v.parse(
    v.object({ path: v.optional(v.array(v.string()), []) }),
    await readConfig(name),
  ).path;

/** The formats a scan reads. */
const readScanFormats = async (name: string): Promise<string[]> =>
  v.parse(v.object({ format: v.array(v.string()) }), await readConfig(name))
    .format;

/** The command of every task that runs a jscpd scan, joined into one text. */
const readScanTasks = async (): Promise<string> => {
  const { tasks } = v.parse(
    v.object({ tasks: v.record(v.string(), v.string()) }),
    await readConfig("deno.json"),
  );
  return Object.values(tasks)
    .filter((command) => command.includes("scripts/cpd.ts"))
    .join(" ");
};

/** The committed counts, read from `cfg/cpd-counts.json`. */
const readCommittedCounts = async (): Promise<Record<string, number>> =>
  readCounts(
    COUNTS_PATH,
    await Deno.readTextFile(join(projectRoot, COUNTS_PATH)),
  );

describe("the scan config directory", () => {
  test("holds the counts file, not the root", async () => {
    expect(await directoryNames(projectRoot)).not.toContain("cpd-counts.json");
  });

  test("holds exactly the declared scans and the counts file, so a new file joins every check", async () => {
    const names = await directoryNames(join(projectRoot, CONFIG_DIR));
    const expected = [
      ...declaredScans.map(([name]) => name),
      COUNTS_PATH,
    ].sort();
    expect(names.map((name) => `${CONFIG_DIR}/${name}`)).toEqual(expected);
  });

  test("resolves every path entry from the config's directory, inside the project", async () => {
    const configDir = join(projectRoot, CONFIG_DIR);
    for (const [name] of declaredScans) {
      for (const entry of await readScanPaths(name)) {
        expect(isAbsolute(entry), `${name}: ${entry}`).toBe(false);
        const target = resolve(configDir, entry);
        const under = relative(projectRoot, target);
        expect(
          under !== "" && !under.startsWith("..") && !isAbsolute(under),
          `${name}: ${entry}`,
        ).toBe(true);
        expect(await pathExists(target), `${name}: ${entry}`).toBe(true);
      }
    }
  });
});

describe("the committed counts", () => {
  test("names one scan for each scan that checks a count", async () => {
    expect(Object.keys(await readCommittedCounts()).sort()).toEqual(
      declaredScans
        .flatMap(([, { count }]) => (count === null ? [] : [count]))
        .sort(),
    );
  });
});

describe("strict jscpd scans", () => {
  test("carry the Type-2 clone options and report every clone kind", async () => {
    const strict = declaredScans.filter(([, promise]) => promise.strict);
    expect(strict.map(([name]) => name)).toContain("cfg/jscpd.json");
    for (const [name] of strict) {
      const config = await readConfig(name);
      expect(config.ignoreIdentifiers, name).toBe(true);
      expect(config.ignoreLiterals, name).toBe(true);
      expect(config.ignoreAnnotations, name).toBe(true);
      expect(Object.keys(config), name).not.toContain("kind");
    }
  });

  test("fail only when a scan reports more places than its count", async () => {
    const cpd = await readScanTasks();
    for (const [name, { count }] of declaredScans) {
      const config = await readConfig(name);
      if (count === null) {
        expect(config.exitCode, name).toBe(1);
        continue;
      }
      expect(cpd, name).toContain(
        `--config ${name} --counts ${COUNTS_PATH} --scan ${count} ` +
          "--fail-on-new-clones",
      );
      expect(Object.keys(config), name).not.toContain("exitCode");
    }
  });
});

/** The ignore list that one TypeScript scan must hold. */
const ignoreListOf = (skipsLazyImports: boolean): string[] => [
  "(?m)^import\\s[^;]*;",
  "(?m)^export\\s+(type\\s+)?(\\*|\\{[^}]*\\})(\\s+as\\s+\\w+)?\\s+from\\s[^;]*;",
  ...(skipsLazyImports ? [LAZY_IMPORT_PATTERN] : []),
];

describe("typescript jscpd scans", () => {
  test("declare the TypeScript format exactly when they read it", async () => {
    const declared = declaredScans.filter(([, promise]) => promise.typescript);
    const readsTypescript: string[] = [];
    for (const [name] of declaredScans) {
      if ((await readScanFormats(name)).includes("typescript")) {
        readsTypescript.push(name);
      }
    }
    expect(readsTypescript).toEqual(declared.map(([name]) => name));
  });

  test("share one import-statement ignore list, and the scans outside the tests skip lazy imports", async () => {
    const typescript = declaredScans.filter(
      ([, promise]) => promise.typescript,
    );
    expect(
      await Promise.all(
        typescript.map(
          async ([name]) => (await readConfig(name)).ignorePattern,
        ),
      ),
    ).toEqual(
      typescript.map(([, promise]) => ignoreListOf(promise.skipsLazyImports)),
    );
    expect(
      typescript
        .filter(([, promise]) => !promise.skipsLazyImports)
        .map(([name]) => name),
    ).toEqual(["cfg/jscpd.helpers.json", "cfg/jscpd.test.json"]);
  });
});

describe("every jscpd scan", () => {
  test("names files by absolute path, so the worst-duplication alert can shorten them", async () => {
    const absolute = await Promise.all(
      declaredScans.map(async ([name]) => (await readConfig(name)).absolute),
    );
    expect(absolute).toEqual(declaredScans.map(() => true));
  });
});
