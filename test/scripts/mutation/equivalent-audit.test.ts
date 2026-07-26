import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  auditEquivalentMutants,
  type EquivalentAuditDeps,
} from "#scripts/mutation/equivalent-audit.ts";
import type { StaticGate } from "#scripts/mutation/execution.ts";
import { generateMutants } from "#scripts/mutation/generate.ts";
import { tempDir } from "#test-utils/files.ts";

const source = "export const value = maybe ?? 0;\n";

const setup = async () => {
  const dir = tempDir({ prefix: "equivalent-audit-" });
  const sourceFile = join(dir.path, "source.ts");
  const ignoreFile = join(dir.path, "equivalents.txt");
  await Deno.writeTextFile(sourceFile, source);
  const mutant = generateMutants(source, sourceFile, true).find(
    (entry) => entry.operator === "??" && entry.newOperator === "||",
  );
  if (!mutant) throw new Error("Expected nullish mutant");
  const entry = `source.ts:${mutant.line}:${mutant.column}  ?? → ||   # same fallback\n`;
  await Deno.writeTextFile(ignoreFile, `# kept comment\n\n${entry}`);
  return { dir, entry, ignoreFile, sourceFile };
};

const gate = (
  label: "lint" | "type-check",
  exit: StaticGate["exit"],
): StaticGate => ({ exit, label, phase: label, remedy: [] });

const deps = (gates: StaticGate[]): EquivalentAuditDeps => ({
  createGates: () => Promise.resolve(gates),
});

const auditSetup = (
  state: Awaited<ReturnType<typeof setup>>,
  gates: StaticGate[] = [],
  write = false,
) =>
  auditEquivalentMutants(
    { ignoreFile: state.ignoreFile, root: state.dir.path, write },
    deps(gates),
  );

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
      killedByTypeCheck: [],
      retained: 0,
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
      killedByTypeCheck: [],
      retained: 1,
    });
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(originalIgnore);
  });

  test("rejects stale entries before changing source files", async () => {
    const state = await setup();
    using _dir = state.dir;
    await Deno.writeTextFile(
      state.ignoreFile,
      "source.ts:99:1 ?? → || # stale\n",
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
      `source.ts:${first.line}:${first.column} ?? → || # killed\nsource.ts:${second.line}:${second.column} ?? → || # kept\n`,
    );

    await auditEquivalentMutants(
      {
        ignoreFile,
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
      `source.ts:${second.line}:${second.column} ?? → || # kept\n`,
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
      killedByTypeCheck: [],
      retained: 0,
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
      killedByTypeCheck: [state.entry.trimEnd()],
      retained: 0,
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
});
