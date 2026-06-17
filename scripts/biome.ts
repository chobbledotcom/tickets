#!/usr/bin/env -S deno run --allow-all
/**
 * Biome runner with an explicit dev-vs-CI split.
 *
 * - **CI** (`BIOME_NPM` or `CI` set): run the npm `@biomejs/biome` package, so
 *   CI needs nothing on PATH. The `lint:ci` task sets `BIOME_NPM=1`.
 * - **Dev** (neither set): run the `biome` on PATH, i.e. the native binary from
 *   the Nix dev shell (`flake.nix`). We deliberately do NOT fall back to the
 *   npm package here: its prebuilt, dynamically-linked binary fails to start on
 *   NixOS, and it can be a different Biome version than the flake pins, which
 *   silently drifts formatting. If `biome` is missing we fail with a hint to
 *   enter the dev shell rather than guess.
 *
 * Usage: deno run -A scripts/biome.ts <biome args...>
 */

/** Check if a command is available in PATH */
const hasCommand = async (name: string): Promise<boolean> => {
  try {
    const result = await new Deno.Command("which", { args: [name] }).output();
    return result.success;
  } catch {
    return false;
  }
};

const useNpm = Boolean(Deno.env.get("BIOME_NPM") || Deno.env.get("CI"));

if (!useNpm && !(await hasCommand("biome"))) {
  console.error(
    "No `biome` on PATH. Enter the Nix dev shell (direnv/`nix develop`) so " +
      "the native Biome is available, or set BIOME_NPM=1 to use the npm package.",
  );
  Deno.exit(1);
}

const cmd = useNpm
  ? new Deno.Command("deno", {
      args: ["run", "-A", "npm:@biomejs/biome", ...Deno.args],
    })
  : new Deno.Command("biome", { args: Deno.args });

const { code } = await cmd.spawn().status;
Deno.exit(code);
