import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { auditSetup, gate, setup } from "./helpers.ts";

/** A lint pass that kills the second mutant it sees, with a type-check that
 * passes everything: the entry dies at the static gate and the prune runs. */
const killingLintGates = () => {
  let lintCalls = 0;
  return [
    gate("lint", () => Promise.resolve(lintCalls++ === 0 ? 0 : 1)),
    gate("type-check", () => Promise.resolve(0)),
  ];
};

describe("a registry written with CRLF line endings", () => {
  /** A Windows checkout writes the registry with `\r\n` line endings. The
   * carriage return is the line ending, never entry content, so a CRLF
   * registry audits, prunes and rewrites exactly like an LF one. */
  test("audits, prunes and rewrites like an LF one", async () => {
    const lf = await setup();
    using _lfDir = lf.dir;
    const crlf = await setup();
    using _crlfDir = crlf.dir;
    await Deno.writeTextFile(
      crlf.ignoreFile,
      (await Deno.readTextFile(crlf.ignoreFile)).replaceAll("\n", "\r\n"),
    );

    const crlfResult = await auditSetup(crlf, killingLintGates(), true);

    expect(crlfResult).toEqual(await auditSetup(lf, killingLintGates(), true));
    expect(await Deno.readTextFile(crlf.ignoreFile)).toBe(
      (await Deno.readTextFile(lf.ignoreFile)).replaceAll("\n", "\r\n"),
    );
  });
});
