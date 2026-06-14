#!/usr/bin/env -S deno run --allow-all
/**
 * Biome runner that works on any OS.
 *
 * The npm `@biomejs/biome` package downloads a prebuilt, dynamically-linked
 * native binary. That binary fails to start on NixOS (its interpreter path
 * doesn't exist), so we prefer a `biome` already on PATH (e.g. installed via
 * Nix) and fall back to the npm package everywhere else.
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

const useSystemBiome = await hasCommand("biome");

const cmd = useSystemBiome
  ? new Deno.Command("biome", { args: Deno.args })
  : new Deno.Command("deno", {
      args: ["run", "-A", "npm:@biomejs/biome", ...Deno.args],
    });

const { code } = await cmd.spawn().status;
Deno.exit(code);
