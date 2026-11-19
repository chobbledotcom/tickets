import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * The devenv CLI is a Nix-built binary that carries its own C++ runtime in its
 * run path. The dev shell exports LD_LIBRARY_PATH for the database FFI, and
 * that export comes first in the loader's search. The CLI then stops with
 * `GLIBCXX_3.4.35 not found` and the release image build fails. A script that
 * runs the CLI from inside the shell must clear the variable first.
 */

const scripts = ["build.sh", "load.sh"];

describe("the container scripts", () => {
  for (const name of scripts) {
    test(`${name} clears the shell library path before it runs the devenv CLI`, () => {
      const lines = Deno.readTextFileSync(
        join(projectRoot, "scripts", "container", name),
      )
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .filter((line) => /(^|[^-]\s)devenv\s/.test(line));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("env -u LD_LIBRARY_PATH devenv build ");
    });
  }
});
