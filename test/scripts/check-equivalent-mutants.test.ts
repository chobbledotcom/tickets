import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { checkEquivalentMutants } from "#scripts/check-equivalent-mutants.ts";
import { generateMutants } from "#scripts/mutation/generate.ts";
import { tempDir } from "#test-utils/files.ts";

const source = "export const read = (x: number | null) => x ?? 0;\n";

/** A project holding one source file and a registry of the given lines. */
const project = async (lines: string[]) => {
  const dir = tempDir({ prefix: "equivalent-check-" });
  const registryDir = join(dir.path, "registry");
  await Deno.mkdir(registryDir);
  await Deno.mkdir(join(dir.path, "src"));
  const sourcePath = join(dir.path, "src", "read.ts");
  await Deno.writeTextFile(sourcePath, source);
  await Deno.writeTextFile(
    join(registryDir, "entries.txt"),
    `${lines.join("\n")}\n`,
  );
  const mutant = generateMutants(source, sourcePath, true).find(
    (m) => m.operator === "??" && m.newOperator === "||",
  );
  if (!mutant) throw new Error("Expected a nullish mutant in the fixture");
  return { anchor: mutant.anchor, dir, registryDir, root: dir.path };
};

const check = (state: Awaited<ReturnType<typeof project>>) =>
  checkEquivalentMutants({
    registryDir: state.registryDir,
    root: state.root,
  });

describe("checking the equivalent-mutant registry resolves", () => {
  test("says nothing when every entry points at a real mutant", async () => {
    const state = await project([]);
    using _dir = state.dir;
    await Deno.writeTextFile(
      join(state.registryDir, "entries.txt"),
      `src/read.ts::${state.anchor}  ?? → ||   # fallback is the only falsy value\n`,
    );

    expect(await check(state)).toEqual([]);
  });

  test("skips comments and blank lines", async () => {
    const state = await project([]);
    using _dir = state.dir;
    await Deno.writeTextFile(
      join(state.registryDir, "entries.txt"),
      `# a heading\n\nsrc/read.ts::${state.anchor}  ?? → ||\n`,
    );

    expect(await check(state)).toEqual([]);
  });

  test("reports an entry with nothing left to suppress", async () => {
    const state = await project(["src/read.ts::noSuchThing~0000000  ?? → ||"]);
    using _dir = state.dir;

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stale");
    expect(problems[0]).toContain("noSuchThing~0000000");
  });

  test("reports the same entry recorded twice", async () => {
    const state = await project([]);
    using _dir = state.dir;
    const entry = `src/read.ts::${state.anchor}  ?? → ||`;
    await Deno.writeTextFile(
      join(state.registryDir, "entries.txt"),
      `${entry}\n${entry}\n`,
    );

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("duplicate");
  });

  /**
   * The runner keys a mutant by its canonical project-relative path, so any
   * other spelling resolves to the same file here while never matching what the
   * runner suppresses.
   */
  test("refuses a path that reaches out of the project and back", async () => {
    const state = await project([]);
    using _dir = state.dir;
    const outAndBack = `../${state.root.split("/").at(-1)}/src/read.ts`;
    await Deno.writeTextFile(
      join(state.registryDir, "entries.txt"),
      `${outAndBack}::${state.anchor}  ?? → ||\n`,
    );

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('path must be written as "src/read.ts"');
  });

  test("refuses an absolute path", async () => {
    const state = await project([]);
    using _dir = state.dir;
    await Deno.writeTextFile(
      join(state.registryDir, "entries.txt"),
      `${join(state.root, "src", "read.ts")}::${state.anchor}  ?? → ||\n`,
    );

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("path must be relative to the project");
  });

  test("refuses a path escaping the project", async () => {
    const state = await project(["../outside.ts::whatever~0000000  ?? → ||"]);
    using _dir = state.dir;

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("path escapes the project");
  });

  test("raises on a line that is neither comment nor entry", async () => {
    const state = await project(["not an entry at all"]);
    using _dir = state.dir;

    await expect(check(state)).rejects.toThrow(
      "Malformed equivalent-mutant entry",
    );
  });
});
