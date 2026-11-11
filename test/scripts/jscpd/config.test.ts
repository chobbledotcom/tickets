import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/** The strict scans treat names, literals and annotations as noise, so a
 * renamed copy is a clone. jscpd labels it `renamed`, and a `kind` filter
 * would hide it. Each scan holds today's clones in a baseline that only
 * shrinks. */
const strictBaselines = {
  ".jscpd.helpers.json": ".jscpd.helpers-baseline.json",
  ".jscpd.json": ".jscpd.baseline.json",
  ".jscpd.support.json": ".jscpd.support-baseline.json",
  ".jscpd.test.json": ".jscpd.test-baseline.json",
} as const;

const strictScans = Object.keys(strictBaselines) as Array<
  keyof typeof strictBaselines
>;

/** Every TypeScript scan skips import and re-export statements, and the
 * destructured dynamic imports that load a module on first use. No source
 * file needs ignore markers around its imports. */
const typescriptScans = [
  ...strictScans,
  ".jscpd.renamed.json",
  ".jscpd.specs.json",
] as const;

const readConfig = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Deno.readTextFile(`${projectRoot}/${name}`));

const readCpdTask = async (): Promise<string> => {
  const { tasks } = (await readConfig("deno.json")) as {
    tasks: { cpd: string };
  };
  return tasks.cpd;
};

describe("strict jscpd scans", () => {
  test("carry the Type-2 clone options and report every clone kind", async () => {
    for (const name of strictScans) {
      const config = await readConfig(name);
      expect(config.ignoreIdentifiers, name).toBe(true);
      expect(config.ignoreLiterals, name).toBe(true);
      expect(config.ignoreAnnotations, name).toBe(true);
      expect(Object.keys(config), name).not.toContain("kind");
    }
  });

  test("fail only on clones that their baseline does not carry", async () => {
    const cpd = await readCpdTask();
    for (const name of strictScans) {
      expect(cpd, name).toContain(
        `--config ${name} --baseline ${strictBaselines[name]} --fail-on-new-clones`,
      );
      expect(Object.keys(await readConfig(name)), name).not.toContain(
        "exitCode",
      );
    }
  });
});

describe("typescript jscpd scans", () => {
  test("share one import-statement ignore list", async () => {
    const [first, ...rest] = await Promise.all(
      typescriptScans.map(
        async (name) => (await readConfig(name)).ignorePattern,
      ),
    );
    expect(first).toEqual([
      "(?m)^import\\s[^;]*;",
      "(?m)^export\\s+(type\\s+)?(\\*|\\{[^}]*\\})(\\s+as\\s+\\w+)?\\s+from\\s[^;]*;",
      "(?m)^\\s*const\\s+\\{[^}]*\\}\\s*=\\s*await\\s+import\\([^)]*\\);",
    ]);
    for (const pattern of rest) expect(pattern).toEqual(first);
  });
});

describe("every jscpd scan", () => {
  test("names files by absolute path, so the worst-duplication alert can shorten them", async () => {
    const scans = [...typescriptScans, ".jscpd.css.json"];
    const absolute = await Promise.all(
      scans.map(async (name) => (await readConfig(name)).absolute),
    );
    expect(absolute).toEqual(scans.map(() => true));
  });
});
