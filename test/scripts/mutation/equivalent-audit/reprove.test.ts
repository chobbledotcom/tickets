import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  auditEquivalentMutants,
  type EquivalentAuditDeps,
  type EquivalentAuditResult,
} from "#scripts/mutation/equivalent-audit.ts";
import { type AuditFixture, gate, setup, source } from "./helpers.ts";

/** The audit over the one-entry fixture with gates that pass everything and
 * the case's distinguishing phase, writing back like the command does. */
const auditWithPassingGates = (
  state: AuditFixture,
  reprove: NonNullable<EquivalentAuditDeps["reprove"]>,
): Promise<EquivalentAuditResult> =>
  auditEquivalentMutants(
    { ignoreFiles: [state.ignoreFile], root: state.dir.path, write: true },
    {
      createGates: () =>
        Promise.resolve([gate("lint", () => Promise.resolve(0))]),
      reprove,
    },
  );

describe("the audit's distinguishing-input phase", () => {
  test("prunes an unconfirmed record when a direct test kills its mutant", async () => {
    const state = await setup();
    using _dir = state.dir;
    await Deno.writeTextFile(state.sourceFile, `${source}// Source edit.\n`);
    const reproved: number[] = [];

    const result = await auditWithPassingGates(state, (entries) => {
      reproved.push(entries.length);
      const [entry] = entries;
      if (!entry) throw new Error("Expected a survivor to reprove");
      return Promise.resolve({
        killedChunks: new Set([`${entry.registry}:${entry.index}`]),
        killedLines: [entry.line],
        untested: [],
      });
    });

    expect(reproved).toEqual([1]);
    expect(result).toEqual({
      checked: 1,
      killedByLint: [],
      killedByTests: [state.entry.trimEnd()],
      killedByTypeCheck: [],
      missing: [],
      retained: 0,
      unconfirmed: [],
      untested: [],
    });
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(
      "# kept comment\n\n",
    );
    expect(await Deno.readTextFile(state.sourceFile)).toBe(
      `${source}// Source edit.\n`,
    );
  });

  test("keeps an entry the distinguishing tests do not kill", async () => {
    const state = await setup();
    using _dir = state.dir;
    const originalIgnore = await Deno.readTextFile(state.ignoreFile);

    const result = await auditWithPassingGates(state, () =>
      Promise.resolve({
        killedChunks: new Set(),
        killedLines: [],
        untested: [],
      }),
    );

    expect(result.killedByTests).toEqual([]);
    expect(result.retained).toBe(1);
    expect(await Deno.readTextFile(state.ignoreFile)).toBe(originalIgnore);
  });

  test("does not run direct tests for a mutant that fails lint", async () => {
    const state = await setup();
    using _dir = state.dir;
    let lintCalls = 0;
    let reproved = 0;

    await auditEquivalentMutants(
      { ignoreFiles: [state.ignoreFile], root: state.dir.path, write: false },
      {
        createGates: () =>
          Promise.resolve([
            gate("lint", () => Promise.resolve(lintCalls++ === 0 ? 0 : 1)),
          ]),
        reprove: () => {
          reproved += 1;
          return Promise.resolve({
            killedChunks: new Set(),
            killedLines: [],
            untested: [],
          });
        },
      },
    );

    expect(reproved).toBe(0);
  });
});
