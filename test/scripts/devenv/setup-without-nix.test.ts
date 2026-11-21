import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * scripts/devenv/setup-without-nix.sh reads each tool version from the file
 * that pins it. These tests run only its `--print-pins` mode, which downloads
 * nothing. They prove that the script and the pin files agree, and that a
 * missing pin stops the script with the file named.
 */

const scriptPath = join(
  projectRoot,
  "scripts",
  "devenv",
  "setup-without-nix.sh",
);

const runScript = async (
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string; stdout: string }> => {
  const output = await new Deno.Command("bash", {
    args: [scriptPath, ...args],
    env,
    stderr: "piped",
    stdout: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stderr: decoder.decode(output.stderr),
    stdout: decoder.decode(output.stdout),
  };
};

const pinned = async (file: string, pattern: RegExp): Promise<string> => {
  const text = await Deno.readTextFile(join(projectRoot, file));
  const found = pattern.exec(text)?.[1];
  if (found === undefined) throw new Error(`No pin in ${file}`);
  return found;
};

describe("setup-without-nix.sh", () => {
  test("prints the versions that the pin files hold", async () => {
    const deno = await pinned("devenv.nix", /denoVersion = "([^"]+)"/);
    const biome = await pinned(
      "biome.json",
      /schemas\/([0-9.]+)\/schema\.json/,
    );
    const stripeMock = await pinned(
      "scripts/stripe-mock/install.ts",
      /STRIPE_MOCK_VERSION = "([^"]+)"/,
    );
    const result = await runScript(["--print-pins"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `deno=${deno}\nbiome=${biome}\nstripe-mock=${stripeMock}\n`,
    );
  });

  test("stops and names the file when a pin is missing", async () => {
    const empty = await Deno.makeTempDir({ prefix: "setup-pins-" });
    try {
      const result = await runScript(["--print-pins"], { TICKETS_ROOT: empty });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no Deno pin in devenv.nix");
    } finally {
      await Deno.remove(empty, { recursive: true });
    }
  });

  test("refuses an argument that it does not know", async () => {
    const result = await runScript(["--install-everything"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "usage: setup-without-nix.sh [--print-pins]",
    );
  });
});
