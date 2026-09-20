import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { checkEquivalentMutants } from "#scripts/mutation/check-equivalents.ts";
import { generateMutants, type Mutant } from "#scripts/mutation/generate.ts";
import { mutantKeyForPath } from "#scripts/mutation/ignore.ts";
import { tempDir } from "#test-utils/files.ts";

const source = "export const read = (x: number | null) => x ?? 0;\n";

/** A project's written shape: one source file at src/read.ts plus a registry
 *  holding the given lines. */
const projectWith = async (lines: string[], writtenSource: string) => {
  const dir = tempDir({ prefix: "equivalent-check-" });
  const registryDir = join(dir.path, "registry");
  await Deno.mkdir(registryDir);
  await Deno.mkdir(join(dir.path, "src"));
  const sourcePath = join(dir.path, "src", "read.ts");
  await Deno.writeTextFile(sourcePath, writtenSource);
  await Deno.writeTextFile(
    join(registryDir, "entries.txt"),
    `${lines.join("\n")}\n`,
  );
  return { dir, registryDir, root: dir.path, sourcePath, writtenSource };
};

/** A project holding the default source, which carries one nullish mutant. */
const project = async (lines: string[]) => {
  const state = await projectWith(lines, source);
  const mutant = generateMutants(
    state.writtenSource,
    state.sourcePath,
    true,
  ).find((m) => m.operator === "??" && m.newOperator === "||");
  if (!mutant) throw new Error("Expected a nullish mutant in the fixture");
  return { ...state, anchor: mutant.anchor, mutant };
};

/** The canonical key the checker would emit for a fixture's mutant. */
const freshKeyFor = (relPath: string, mutant: Mutant): string =>
  mutantKeyForPath(relPath, mutant);

/** The nullish mutants a written source carries. */
const nullishMutantsIn = (state: Awaited<ReturnType<typeof projectWith>>) =>
  generateMutants(state.writtenSource, state.sourcePath, true).filter(
    (m) => m.operator === "??" && m.newOperator === "||",
  );

const check = (state: { registryDir: string; root: string }) =>
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

  /** A file may be named anything, including something that starts with the
   * mark a comment starts with. Written escaped, its entry is still an entry,
   * and the checker still opens the file it names. */
  test("resolves an entry for a source whose name starts with a comment mark", async () => {
    const state = await project([]);
    using _dir = state.dir;
    await Deno.writeTextFile(join(state.root, "src", "# read.ts"), source);
    await Deno.writeTextFile(
      join(state.registryDir, "entries.txt"),
      `src/%23 read.ts::${state.anchor}  ?? → ||\n`,
    );

    expect(await check(state)).toEqual([]);
  });

  /** A rename or move that stales an entry leaves the same mutation in place
   * elsewhere in the file, so the checker names the stale entry and its fresh
   * key, and the author pastes it instead of re-running a mutation run to
   * rediscover it. */
  test("prints the fresh key for a stale entry whose mutation still occurs", async () => {
    const state = await project(["src/read.ts::noSuchThing~0000000  ?? → ||"]);
    using _dir = state.dir;

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stale");
    expect(problems[0]).toContain("noSuchThing~0000000");
    expect(problems[0]).toContain(
      `to accept: ${freshKeyFor("src/read.ts", state.mutant)}`,
    );
  });

  /** Two sites carrying the same mutation are both candidates, so the checker
   * lists each and the author picks instead of a run proving one of them out. */
  test("lists every same-mutation key when the mutation occurs more than once", async () => {
    const writtenSource =
      "export const a = (x: number | null) => x ?? 0;\n" +
      "export const b = (x: number | null) => x ?? 0;\n";
    const state = await projectWith(
      ["src/read.ts::noSuchThing~0000000  ?? → ||"],
      writtenSource,
    );
    using _dir = state.dir;
    const candidates = nullishMutantsIn(state);
    expect(candidates.length).toBeGreaterThan(1);

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    const acceptLines = problems[0]!
      .split("\n")
      .filter((line) => line.startsWith("to accept: "));
    expect(acceptLines.map((line) => line.slice("to accept: ".length))).toEqual(
      candidates.map((m) => freshKeyFor("src/read.ts", m)),
    );
  });

  /** A mutation the file no longer produces anywhere suppresses nothing, so
   * the entry has to go — and naming that beats a generic rename question. */
  test("says to delete a stale entry whose mutation no longer occurs", async () => {
    const state = await projectWith(
      ["src/read.ts::whatever~0000000  ?? → ||"],
      "export const read = (x: number | null) => x || 0;\n",
    );
    using _dir = state.dir;
    expect(nullishMutantsIn(state)).toEqual([]);

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stale");
    expect(problems[0]).toContain("delete");
    expect(problems[0]).not.toContain("to accept:");
  });

  /** `keysFor` generates exhaustively, so an entry naming a replacement the
   * one-each default mode never produces still resolves. */
  test("resolves an entry whose mutation only exhaustive generation makes", async () => {
    const state = await project([]);
    using _dir = state.dir;
    const mutant = generateMutants(source, state.sourcePath, true).find(
      (m) => m.operator === "0" && m.newOperator === "-1",
    );
    if (!mutant) throw new Error("Expected an exhaustive number mutant");
    await Deno.writeTextFile(
      join(state.registryDir, "entries.txt"),
      `src/read.ts::${mutant.anchor}  0 → -1\n`,
    );

    expect(await check(state)).toEqual([]);
  });

  /** A path spelled so its own canonical form is the parent directory escapes
   * the project, so the entry is refused before any file is read. */
  test("refuses a path whose canonical form is the parent directory", async () => {
    const state = await project(["..::x~0000000  0 → 1"]);
    using _dir = state.dir;

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("path escapes the project");
  });

  /** A path holding spaces keeps them in the key, and the fresh-key search
   * splits the key at the anchor's end regardless — first space after the
   * `::`, never one inside the path. */
  test("prints the fresh key for a stale entry whose path holds spaces", async () => {
    const relPath = "src/a b/c d/read.ts";
    const state = await projectWith(
      [`${relPath}::noSuchThing~0000000  ?? → ||`],
      source,
    );
    using _dir = state.dir;
    await Deno.mkdir(join(state.root, "src", "a b", "c d"), {
      recursive: true,
    });
    await Deno.writeTextFile(join(state.root, relPath), source);

    const mutant = nullishMutantsIn({
      ...state,
      sourcePath: join(state.root, relPath),
      writtenSource: source,
    })[0];
    if (!mutant) throw new Error("Expected a nullish mutant in the fixture");

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stale");
    expect(problems[0]).toContain(`to accept: ${freshKeyFor(relPath, mutant)}`);
  });

  // A branch that deletes or renames a source still has to be told which line
  // to remove, so a missing file reads as stale rather than killing the run.
  test("reports an entry whose source file is gone", async () => {
    const state = await project([
      "src/read.ts::gone~0000000  ?? \u2192 ||   # its source was deleted",
    ]);
    using _dir = state.dir;
    await Deno.remove(join(state.root, "src", "read.ts"));

    const problems = await check(state);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stale");
    expect(problems[0]).toContain("src/read.ts::gone~0000000");
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
