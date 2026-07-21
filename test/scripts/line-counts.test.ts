import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { printLineCounts } from "#scripts/line-counts-lib.ts";
import { tempDir } from "#test-utils/files.ts";

describe("line-counts", () => {
  test("prints recursive line counts grouped by extension", async () => {
    using dir = tempDir();
    const root = dir.path;
    await Deno.mkdir(`${root}/nested`);
    await Deno.writeTextFile(`${root}/main.ts`, "one\nunterminated");
    await Deno.writeTextFile(`${root}/nested/extra.ts`, "one\ntwo\n");
    await Deno.writeTextFile(`${root}/nested/client.js`, "one\n");
    await Deno.writeTextFile(`${root}/nested/view.tsx`, "one\n");
    await Deno.writeTextFile(`${root}/nested/grunt`, "one\ntwo\nthree");

    const output: string[] = [];
    await printLineCounts([root], (line) => output.push(line));

    expect(output).toEqual([
      [
        "extension           files    lines",
        ".ts                     2        3",
        "[no extension]          1        2",
        ".js                     1        1",
        ".tsx                    1        1",
        "TOTAL                   5        7",
      ].join("\n"),
    ]);
  });
});
