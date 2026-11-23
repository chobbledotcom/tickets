import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { collectTestFiles, mustRunAlone } from "#scripts/test-groups.ts";

/** A suite that turns the op sanitizer off may leave a timer running. In a
 * shared isolate, that timer ends inside the next suite and fails it. */
const turnsOpSanitizerOff = (source: string): boolean =>
  source.includes(["sanitizeOps", "false"].join(": "));

describe("test files that turn the op sanitizer off", () => {
  test("each one keeps its own isolate", async () => {
    const files = await collectTestFiles(Deno.cwd());
    const shared: string[] = [];
    for (const file of files) {
      const source = await Deno.readTextFile(file);
      if (turnsOpSanitizerOff(source) && !mustRunAlone(source)) {
        shared.push(file);
      }
    }

    expect(shared).toEqual([]);
  });
});
