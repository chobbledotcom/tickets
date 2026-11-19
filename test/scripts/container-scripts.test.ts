import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * The devenv CLI is a Nix-built binary that carries its own C++ runtime in its
 * run path. The dev shell exports LD_LIBRARY_PATH for the database FFI, and
 * that export comes first in the loader's search. The CLI then stops with
 * `GLIBCXX_3.4.35 not found` and the release image build fails. A container
 * script that runs the CLI must clear the variable first.
 *
 * `nix/container.nix` copies each file in `scripts/container` into the devenv
 * environment, so every one of them runs inside the shell.
 */

const containerDir = join(projectRoot, "scripts", "container");

/** The image output name that `nix/container.nix` declares. */
const imageOutput = (): string => {
  const declared = /^\s*outputs\.([A-Za-z0-9_-]+)\s*=/m.exec(
    Deno.readTextFileSync(join(projectRoot, "nix", "container.nix")),
  );
  if (declared === null) {
    throw new Error("nix/container.nix declares no outputs.<name>");
  }
  return `outputs.${declared[1]}`;
};

/** The lines of one script that run the CLI, with comment lines removed. */
const cliLines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#"))
    .filter((line) => /(?:^|\s)devenv\s/.test(line));

const read = (name: string): string =>
  Deno.readTextFileSync(join(containerDir, name));

const scripts = [...Deno.readDirSync(containerDir)]
  .filter((entry) => entry.isFile && entry.name.endsWith(".sh"))
  .map((entry) => entry.name);

describe("the container scripts", () => {
  test("run the CLI with the shell library path cleared", () => {
    const safe = `env -u LD_LIBRARY_PATH devenv build ${imageOutput()}`;

    const problems = scripts.flatMap((name) =>
      cliLines(read(name))
        .filter((line) => !line.startsWith(safe))
        .map((line) => `${name}: ${line}`),
    );

    expect(problems).toEqual([]);
  });

  test("the image build and load run the CLI", () => {
    const callers = scripts.filter((name) => cliLines(read(name)).length > 0);

    expect(callers).toEqual(expect.arrayContaining(["build.sh", "load.sh"]));
  });

  test("load reads the stream of the declared image output", () => {
    expect(read("load.sh")).toContain(`."${imageOutput()}"`);
  });
});
