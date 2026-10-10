import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { shortHash } from "#scripts/checksum.ts";
import { auditEquivalentMutants } from "#scripts/mutation/equivalent-audit.ts";
import { generateMutants } from "#scripts/mutation/generate.ts";
import { tempDir } from "#test-utils/files.ts";
import {
  type AuditFixture,
  auditSetup,
  deps,
  gate,
  setup,
  source,
} from "./helpers.ts";

describe("equivalent-mutant static audit", () => {
  test("reports a mutant killed by lint without running type-check", async () => {
    const state = await setup();
    using _dir = state.dir;
    const calls: string[] = [];
    const result = await auditSetup(state, [
      gate("lint", async (file) => {
        calls.push(await Deno.readTextFile(file));
        return calls.length === 1 ? 0 : 1;
      }),
      gate("type-check", () => {
        calls.push("type-check");
        return Promise.resolve(0);
      }),
    ]);

    expect(result).toEqual({
      checked: 1,
      killedByLint: [state.entry.trimEnd()],
      killedByTests: [],
      killedByTypeCheck: [],
      retained: 0,
      unconfirmed: [],
      untested: [],
    });
    expect(calls).toEqual([source, "type-check", source.replace("??", "||")]);
    expect(await Deno.readTextFile(state.sourceFile)).toBe(source);
  });

  test("writes only statically killed entry lines and preserves surrounding text", async () => {
    const state = await setup();
    using _dir = state.dir;
    let lintCalls = 0;
    const result = await auditSetup(
      state,
      [
        gate("lint", () => Promise.resolve(lintCalls++ === 0 ? 0 : 1)),
        gate("type-check", () => Promise.resolve(0)),
      ],
      true,
    );

    expect(result.killedByLint).toEqual([state.entry.trimEnd()]);
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(
      "# kept comment\n\n",
    );
    expect(await Deno.readTextFile(state.sourceFile)).toBe(source);
  });

  test("retains mutants that pass both static gates", async () => {
    const state = await setup();
    using _dir = state.dir;
    const originalIgnore = await Deno.readTextFile(state.ignoreFile);
    const result = await auditSetup(
      state,
      [
        gate("lint", () => Promise.resolve(0)),
        gate("type-check", () => Promise.resolve(0)),
      ],
      true,
    );

    expect(result).toEqual({
      checked: 1,
      killedByLint: [],
      killedByTests: [],
      killedByTypeCheck: [],
      retained: 1,
      unconfirmed: [],
      untested: [],
    });
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(originalIgnore);
  });

  test("rejects stale entries before changing source files", async () => {
    const state = await setup();
    using _dir = state.dir;
    await Deno.writeTextFile(
      state.ignoreFile,
      "source.ts::noSuchThing ?? → ||  audited:0000000 # stale\n",
    );

    await expect(auditSetup(state)).rejects.toThrow(
      "No generated mutant matches",
    );
    expect(await Deno.readTextFile(state.sourceFile)).toBe(source);
  });

  test("keeps a later entry after removing an earlier killed entry", async () => {
    const dir = tempDir({ prefix: "equivalent-audit-rewrite-" });
    using _dir = dir;
    const sourceFile = join(dir.path, "source.ts");
    const ignoreFile = join(dir.path, "equivalents.txt");
    const twoValues =
      "export const first = maybe ?? 0;\nexport const second = other ?? 0;\n";
    await Deno.writeTextFile(sourceFile, twoValues);
    const mutants = generateMutants(twoValues, sourceFile, true).filter(
      (entry) => entry.operator === "??" && entry.newOperator === "||",
    );
    const [first, second] = mutants;
    if (!first || !second) throw new Error("Expected two nullish mutants");
    await Deno.writeTextFile(
      ignoreFile,
      `source.ts::${first.anchor} ?? → ||  audited:${shortHash(twoValues)} # killed\nsource.ts::${second.anchor} ?? → ||  audited:${shortHash(twoValues)} # kept\n`,
    );

    await auditEquivalentMutants(
      {
        ignoreFiles: [ignoreFile],
        root: dir.path,
        write: true,
      },
      deps([
        gate("lint", async (file) =>
          (await Deno.readTextFile(file)).startsWith(
            "export const first = maybe || 0",
          )
            ? 1
            : 0,
        ),
        gate("type-check", () => Promise.resolve(0)),
      ]),
    );

    expect(await Deno.readTextFile(ignoreFile)).toBe(
      `source.ts::${second.anchor} ?? → ||  audited:${shortHash(twoValues)} # kept\n`,
    );
    expect(await Deno.readTextFile(sourceFile)).toBe(twoValues);
  });

  test("restores source when a mutant gate fails", async () => {
    const state = await setup();
    using _dir = state.dir;
    let lintCalls = 0;

    await expect(
      auditSetup(state, [
        gate("lint", () => {
          lintCalls += 1;
          if (lintCalls > 1) throw new Error("lint crashed");
          return Promise.resolve(0);
        }),
        gate("type-check", () => Promise.resolve(0)),
      ]),
    ).rejects.toThrow("lint crashed");

    expect(await Deno.readTextFile(state.sourceFile)).toBe(source);
  });

  test("accepts an empty equivalent-mutant catalog", async () => {
    const state = await setup();
    using _dir = state.dir;
    await Deno.writeTextFile(state.ignoreFile, "");

    expect(await auditSetup(state)).toEqual({
      checked: 0,
      killedByLint: [],
      killedByTests: [],
      killedByTypeCheck: [],
      retained: 0,
      unconfirmed: [],
      untested: [],
    });
  });

  test("rejects malformed catalog entries", async () => {
    const state = await setup();
    using _dir = state.dir;
    await Deno.writeTextFile(state.ignoreFile, "not a mutant\n");

    await expect(auditSetup(state)).rejects.toThrow(
      "Malformed equivalent-mutant entry: not a mutant",
    );
  });

  test("rejects duplicate catalog entries", async () => {
    const state = await setup();
    using _dir = state.dir;
    await Deno.writeTextFile(state.ignoreFile, state.entry.repeat(2));

    await expect(auditSetup(state)).rejects.toThrow(
      "Duplicate equivalent-mutant entry",
    );
  });

  test("rejects an entry duplicated across two registry files", async () => {
    const state = await setup();
    using _dir = state.dir;
    const secondFile = join(state.dir.path, "second.txt");
    await Deno.writeTextFile(secondFile, state.entry);

    await expect(
      auditEquivalentMutants(
        {
          ignoreFiles: [state.ignoreFile, secondFile],
          root: state.dir.path,
          write: false,
        },
        deps([]),
      ),
    ).rejects.toThrow("Duplicate equivalent-mutant entry");
  });

  test("prunes a killed entry from its own registry file only", async () => {
    const state = await setup();
    using _dir = state.dir;
    // A second registry file whose entry survives the gates untouched.
    const secondSource = "export const other = second ?? 0;\n";
    const secondSourceFile = join(state.dir.path, "second-source.ts");
    await Deno.writeTextFile(secondSourceFile, secondSource);
    const kept = generateMutants(secondSource, secondSourceFile, true).find(
      (entry) => entry.operator === "??" && entry.newOperator === "||",
    );
    if (!kept) throw new Error("Expected nullish mutant");
    const secondFile = join(state.dir.path, "second.txt");
    const keptEntry = `second-source.ts::${kept.anchor} ?? → ||  audited:0000000 # kept\n`;
    await Deno.writeTextFile(secondFile, keptEntry);

    await auditEquivalentMutants(
      {
        ignoreFiles: [state.ignoreFile, secondFile],
        root: state.dir.path,
        write: true,
      },
      deps([
        // Kill only the first registry's mutant: the mutated text of
        // state.sourceFile fails lint, everything else passes.
        gate("lint", async (file) =>
          (await Deno.readTextFile(file)).startsWith(
            "export const value = maybe || 0",
          )
            ? 1
            : 0,
        ),
      ]),
    );

    expect(await Deno.readTextFile(state.ignoreFile)).toBe(
      "# kept comment\n\n",
    );
    expect(await Deno.readTextFile(secondFile)).toBe(keptEntry);
  });

  test("rejects absolute source paths", async () => {
    const state = await setup();
    using _dir = state.dir;
    await Deno.writeTextFile(
      state.ignoreFile,
      state.entry.replace("source.ts", state.sourceFile),
    );

    await expect(auditSetup(state)).rejects.toThrow(
      "Equivalent-mutant path must be relative",
    );
  });

  test("rejects source paths outside the project", async () => {
    const state = await setup();
    using _dir = state.dir;
    await Deno.writeTextFile(
      state.ignoreFile,
      state.entry.replace("source.ts", "../source.ts"),
    );

    await expect(auditSetup(state)).rejects.toThrow(
      "Equivalent-mutant path escapes the project",
    );
  });

  test("rejects an unclean source baseline", async () => {
    const state = await setup();
    using _dir = state.dir;

    await expect(
      auditSetup(state, [gate("lint", () => Promise.resolve(1))]),
    ).rejects.toThrow(`Unmutated ${state.sourceFile} does not pass lint.`);
  });

  test("reports a mutant killed by type-check", async () => {
    const state = await setup();
    using _dir = state.dir;
    let typeCheckCalls = 0;

    const result = await auditSetup(state, [
      gate("lint", () => Promise.resolve(0)),
      gate("type-check", () => Promise.resolve(typeCheckCalls++ === 0 ? 0 : 1)),
    ]);

    expect(result).toEqual({
      checked: 1,
      killedByLint: [],
      killedByTests: [],
      killedByTypeCheck: [state.entry.trimEnd()],
      retained: 0,
      unconfirmed: [],
      untested: [],
    });
  });

  test("refuses to overwrite a catalog changed during the audit", async () => {
    const state = await setup();
    using _dir = state.dir;
    let lintCalls = 0;

    await expect(
      auditSetup(
        state,
        [
          gate("lint", async () => {
            lintCalls += 1;
            if (lintCalls === 2) {
              await Deno.writeTextFile(state.ignoreFile, "# changed\n");
              return 1;
            }
            return 0;
          }),
          gate("type-check", () => Promise.resolve(0)),
        ],
        true,
      ),
    ).rejects.toThrow("Equivalent-mutant file changed during the audit.");
    expect(await Deno.readTextFile(state.ignoreFile)).toBe("# changed\n");
    expect(await Deno.readTextFile(state.sourceFile)).toBe(source);
  });

  /** The stamp records the file text the proof was re-derived against. A file
   * that has changed since leaves the entry unconfirmed: the audit skips it —
   * no gate check, no prune — and names it for a person to re-derive. */
  const setupWithStaleStamp = async (): Promise<
    AuditFixture & { stale: string }
  > => {
    const state = await setup();
    const stale = state.entry.replace(shortHash(source), "0000000");
    await Deno.writeTextFile(state.ignoreFile, `# kept comment\n\n${stale}`);
    return { ...state, stale };
  };

  test("skips an entry whose stamp predates the source text", async () => {
    const state = await setupWithStaleStamp();
    using _dir = state.dir;
    const calls: string[] = [];

    const result = await auditSetup(state, [
      gate("lint", (file) => {
        calls.push(file);
        return Promise.resolve(1);
      }),
      gate("type-check", (file) => {
        calls.push(file);
        return Promise.resolve(0);
      }),
    ]);

    expect(result).toEqual({
      checked: 1,
      killedByLint: [],
      killedByTests: [],
      killedByTypeCheck: [],
      retained: 0,
      unconfirmed: [state.stale.trimEnd()],
      untested: [],
    });
    expect(calls).toEqual([]);
    expect(await Deno.readTextFile(state.sourceFile)).toBe(source);
  });

  test("skips an unconfirmed entry even with --write", async () => {
    const state = await setupWithStaleStamp();
    using _dir = state.dir;

    const result = await auditEquivalentMutants(
      { ignoreFiles: [state.ignoreFile], root: state.dir.path, write: true },
      deps([gate("lint", () => Promise.resolve(0))]),
    );

    expect(result.unconfirmed).toEqual([state.stale.trimEnd()]);
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(
      `# kept comment\n\n${state.stale}`,
    );
  });
});
