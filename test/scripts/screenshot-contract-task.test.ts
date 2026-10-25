/**
 * The `test:screenshot-contract` task names each browser contract by hand.
 * A contract file the task misses never runs, so these tests pin the task's
 * words to the files on disk: every `*-browser.contract.ts` file under the
 * source trees is covered, by exact path or by a glob.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { readJsonOrThrow } from "#scripts/read-json.ts";
import { SOURCE_DIRS } from "#scripts/source-dirs.ts";
import { collectFiles } from "#scripts/walk-files.ts";

const ConfigSchema = v.object({
  tasks: v.object({ "test:screenshot-contract": v.string() }),
});

/** The task line's words: one token per path or glob. */
const taskTokens = async (): Promise<string[]> => {
  const config = await readJsonOrThrow("deno.json", ConfigSchema);
  return config.tasks["test:screenshot-contract"]
    .split("&&")
    .flatMap((segment) => segment.trim().split(/\s+/));
};

/** A token covers a file when it names the file exactly, or when it is a glob
 * whose directory holds the file. Shell globs do not cross a slash, so a glob
 * covers its directory's direct children only, under the token's own suffix. */
const tokenCovers = (token: string, file: string): boolean => {
  if (token === file) return true;
  const star = token.indexOf("*");
  if (star < 0) return false;
  const dir = token.slice(0, star);
  const suffix = token.slice(star + 1);
  if (!file.startsWith(dir)) return false;
  const stem = file.slice(dir.length);
  if (!stem.endsWith(suffix)) return false;
  return !stem.slice(0, stem.length - suffix.length).includes("/");
};

/** The contract files no token covers. */
const uncoveredFiles = (
  tokens: readonly string[],
  files: readonly string[],
): string[] =>
  files.filter((file) => !tokens.some((token) => tokenCovers(token, file)));

describe("the screenshot-contract task's file list", () => {
  test("covers every browser contract file in the repository", async () => {
    const tokens = await taskTokens();
    const files = (
      await Promise.all(
        SOURCE_DIRS.map((root) =>
          collectFiles(root, (path) => /-browser\.contract\.ts$/.test(path)),
        ),
      )
    ).flat();
    expect(uncoveredFiles(tokens, files)).toEqual([]);
  });

  test("reads a glob as that directory's direct children", () => {
    const tokens = ["test/scripts/*-browser.contract.ts"];
    expect(
      uncoveredFiles(tokens, [
        "test/scripts/screenshots-browser.contract.ts",
        "test/scripts/deep/extra-browser.contract.ts",
        "test/scripts/extra-browser-contract.ts",
      ]),
    ).toEqual([
      "test/scripts/deep/extra-browser.contract.ts",
      "test/scripts/extra-browser-contract.ts",
    ]);
  });
});
