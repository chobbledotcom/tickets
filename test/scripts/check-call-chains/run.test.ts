import { assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  repeatedChains,
  runCallChainCheck,
} from "#scripts/check-call-chains/run.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

/** The lines one check run writes, split by the stream it wrote them to. */
type CheckRun = { code: number; errors: string[]; out: string[] };

/** Run the chain check over `roots` with its own collecting streams. */
const checkRun = async (
  roots: readonly string[],
  accepted: Record<string, number>,
): Promise<CheckRun> => {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await runCallChainCheck(roots, accepted, {
    log: (line) => out.push(line),
    logError: (line) => errors.push(line),
  });
  return { code, errors, out };
};

describe("check-call-chains run", () => {
  let dir: TempPath;

  beforeEach(() => {
    dir = tempDir();
    Deno.mkdirSync(`${dir.path}/src`, { recursive: true });
  });

  afterEach(() => {
    dir.dispose();
  });

  const write = (name: string, content: string): string => {
    const path = `${dir.path}/src/${name}`;
    Deno.writeTextFileSync(path, content);
    return path;
  };

  test("lists each repeated chain with the sites that hold it", async () => {
    write("one.ts", "a(b(c(1)))\n");
    write("two.ts", "a(b(c(2)))\nconst flat = 1;\n");

    expect(await repeatedChains([dir.path])).toEqual({ "a(b(c(": 2 });
  });

  test("passes a chain at its recorded site count", async () => {
    write("one.ts", "a(b(c(1)))\n");
    write("two.ts", "a(b(c(2)))\n");
    const { code, errors, out } = await checkRun([dir.path], { "a(b(c(": 2 });

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    assertArrayIncludes(out, [
      "No chain of three or more methods repeats more often than its recorded count.",
    ]);
  });

  test("fails a repeated chain no entry covers, naming its line and count", async () => {
    const one = write("one.ts", "a(b(c(1)))\n");
    write("two.ts", "a(b(c(2)))\n");
    const { code, errors } = await checkRun([dir.path], {});

    expect(code).toBe(1);
    assertStringIncludes(
      errors[0] ?? "",
      `${one}:1 [repeated-chain]: a(b(c( repeats at 2 sites`,
    );
    assertStringIncludes(
      errors.at(-1) ?? "",
      '2 repeated chain issue(s) found. See "Keep methods flat" in AGENTS.md.',
    );
  });

  test("asks for an entry whose chain no longer repeats to be deleted", async () => {
    write("one.ts", "a(b(c(1)))\n");
    const { code, errors } = await checkRun([dir.path], { "a(b(c(": 2 });

    expect(code).toBe(1);
    assertStringIncludes(
      errors[0] ?? "",
      "a(b(c( [stale-entry]: a(b(c( repeats no more",
    );
  });
});
