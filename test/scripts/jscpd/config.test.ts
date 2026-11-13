import { isAbsolute, join, relative, resolve } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { projectRoot } from "#scripts/project-root.ts";
import { directoryNames, pathExists } from "#test-utils/files.ts";

/** The directory that holds every scan config and its committed baseline. */
const CONFIG_DIR = "cfg";

/** What one scan config promises. The test holds this table to the names in
 * `cfg/`, so a new scan must declare itself here. */
interface ScanPromise {
  /** The committed baseline the scan fails against, or null when it holds none
   * and relies on jscpd's own exit code instead. */
  baseline: string | null;
  /** The scan treats names, literals and annotations as noise, so a renamed
   * copy is a clone. jscpd labels it `renamed`, and a `kind` filter would hide
   * it. */
  strict: boolean;
  /** The scan reads TypeScript, so it skips import and re-export statements. */
  typescript: boolean;
}

const scans: Record<string, ScanPromise> = {
  "cfg/jscpd.css.json": {
    baseline: null,
    strict: false,
    typescript: false,
  },
  "cfg/jscpd.helpers.json": {
    baseline: "cfg/.jscpd.helpers-baseline.json",
    strict: true,
    typescript: true,
  },
  "cfg/jscpd.json": {
    baseline: "cfg/.jscpd.baseline.json",
    strict: true,
    typescript: true,
  },
  "cfg/jscpd.renamed.json": {
    baseline: "cfg/.jscpd.renamed-baseline.json",
    strict: false,
    typescript: true,
  },
  "cfg/jscpd.specs.json": {
    baseline: "cfg/.jscpd.specs-baseline.json",
    strict: false,
    typescript: true,
  },
  "cfg/jscpd.support.json": {
    baseline: "cfg/.jscpd.support-baseline.json",
    strict: true,
    typescript: true,
  },
  "cfg/jscpd.test.json": {
    baseline: "cfg/.jscpd.test-baseline.json",
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

describe("the scan config directory", () => {
  test("holds every scan config and baseline, so the root holds neither", async () => {
    const rootNames = await directoryNames(projectRoot);
    expect(rootNames.filter((name) => name.startsWith(".jscpd."))).toEqual([]);
  });

  test("holds exactly the declared scans and baselines, so a new file joins every check", async () => {
    const names = await directoryNames(join(projectRoot, CONFIG_DIR));
    const expected = [
      ...declaredScans.map(([name]) => name),
      ...declaredScans.flatMap(([, { baseline }]) =>
        baseline === null ? [] : [baseline],
      ),
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

  test("fail only on clones that their baseline does not carry", async () => {
    const cpd = await readScanTasks();
    for (const [name, { baseline }] of declaredScans) {
      const config = await readConfig(name);
      if (baseline === null) {
        expect(config.exitCode, name).toBe(1);
        continue;
      }
      expect(cpd, name).toContain(
        `--config ${name} --baseline ${baseline} --fail-on-new-clones`,
      );
      expect(await pathExists(join(projectRoot, baseline)), baseline).toBe(
        true,
      );
      expect(Object.keys(config), name).not.toContain("exitCode");
    }
  });
});

describe("typescript jscpd scans", () => {
  test("share one import-statement ignore list", async () => {
    const declared: string[] = [];
    const readsTypescript: string[] = [];
    for (const [name, { typescript }] of declaredScans) {
      if (typescript) declared.push(name);
      if ((await readScanFormats(name)).includes("typescript")) {
        readsTypescript.push(name);
      }
    }
    expect(readsTypescript).toEqual(declared);
    for (const name of declared) {
      expect((await readConfig(name)).ignorePattern, name).toEqual([
        "(?m)^import\\s[^;]*;",
        "(?m)^export\\s+(type\\s+)?(\\*|\\{[^}]*\\})(\\s+as\\s+\\w+)?\\s+from\\s[^;]*;",
      ]);
    }
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
