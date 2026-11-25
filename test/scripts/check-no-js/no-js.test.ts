import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { javascriptFindings } from "#scripts/check-no-js/rules.ts";
import { runNoJsCheck } from "#scripts/check-no-js/run.ts";
import type { RunCommand } from "#scripts/precommit/git.ts";
import { capturedCheckOutput } from "#test-utils/check-script.ts";

const gitListing =
  (stdout: string, code = 0, stderr = ""): RunCommand =>
  async () => ({ code, stderr, stdout, success: code === 0 });

const check = async (run: RunCommand) => {
  const output = capturedCheckOutput();
  const code = await runNoJsCheck(run, output);
  return { code, lines: output.lines };
};

describe("javascriptFindings", () => {
  test("names every JavaScript extension and leaves other files alone", () => {
    const findings = javascriptFindings([
      "src/a.js",
      "src/b.mjs",
      "src/c.cjs",
      "src/d.jsx",
      "src/e.ts",
      "src/f.tsx",
      "deno.json",
      "data/rows.jsonl",
      "src/g.js.map",
    ]);
    expect(findings).toEqual([
      "src/a.js [no-javascript]: JavaScript files are not supported — write the file in TypeScript with the .ts or .tsx extension",
      "src/b.mjs [no-javascript]: JavaScript files are not supported — write the file in TypeScript with the .ts or .tsx extension",
      "src/c.cjs [no-javascript]: JavaScript files are not supported — write the file in TypeScript with the .ts or .tsx extension",
      "src/d.jsx [no-javascript]: JavaScript files are not supported — write the file in TypeScript with the .ts or .tsx extension",
    ]);
  });
});

describe("check:no-js", () => {
  test("fails and names each tracked JavaScript file", async () => {
    const { code, lines } = await check(
      gitListing("src/ok.ts\0src/ui/old.js\0docs/page.md\0"),
    );
    expect(code).toBe(1);
    assertStringIncludes(lines[0] ?? "", "src/ui/old.js [no-javascript]");
    assertStringIncludes(lines[1] ?? "", "1 JavaScript file issue(s) found");
  });

  test("passes when every tracked file is TypeScript or data", async () => {
    const { code, lines } = await check(gitListing("src/ok.ts\0deno.json\0"));
    expect(code).toBe(0);
    expect(lines).toEqual(["Every tracked source file is TypeScript."]);
  });

  test("fails loudly when git cannot list the files", async () => {
    await expect(
      check(gitListing("", 128, "not a git repository\n")),
    ).rejects.toThrow("git ls-files failed: not a git repository");
  });
});
