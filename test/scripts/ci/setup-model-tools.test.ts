import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * scripts/ci/setup-model-tools.sh installs the model tools without devenv.
 * devenv.nix stays the source of the pins, so these tests hold the script to
 * the same Deno version and the same Apalache release and hash.
 */

const readProjectFile = (...parts: string[]): Promise<string> =>
  Deno.readTextFile(join(projectRoot, ...parts));

/** The first capture group of a pattern. A missing pin fails with its name. */
const captured = (text: string, pattern: RegExp, name: string): string => {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) throw new Error(`No ${name} found.`);
  return value;
};

const readScript = (): Promise<string> =>
  readProjectFile("scripts", "ci", "setup-model-tools.sh");

const scriptPin = (script: string, name: string): string =>
  captured(script, new RegExp(`^${name}="([^"]+)"$`, "m"), name);

describe("model tools script", () => {
  test("installs the Deno version that devenv.nix pins", async () => {
    const script = await readScript();
    const nix = await readProjectFile("devenv.nix");

    expect(scriptPin(script, "DENO_VERSION")).toBe(
      captured(nix, /denoVersion = "([^"]+)";/, "denoVersion"),
    );
  });

  test("installs the Apalache release that devenv.nix pins", async () => {
    const script = await readScript();
    const nix = await readProjectFile("devenv.nix");

    expect({
      hash: scriptPin(script, "APALACHE_SHA256"),
      version: scriptPin(script, "APALACHE_VERSION"),
    }).toEqual({
      hash: captured(
        nix,
        /apalacheArchive = pkgs\.fetchurl \{[^}]*sha256 = "([0-9a-f]{64})";/,
        "Apalache hash",
      ),
      version: captured(
        nix,
        /download\/v([0-9.]+)\/apalache-[0-9.]+\.tgz/,
        "Apalache version",
      ),
    });
  });
});
