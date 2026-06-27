#!/usr/bin/env -S deno run --allow-all
/**
 * Biome runner that prefers the local native binary.
 *
 * If `biome` exists on PATH, use it. That keeps Nix dev shells on the native
 * package even for CI-style checks. If it is missing, fall back to the npm
 * package so hosted CI can run without a separate Biome install step.
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

const hasLocalBiome = await hasCommand("biome");
const cmd = hasLocalBiome
  ? new Deno.Command("biome", { args: Deno.args })
  : new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "npm:@biomejs/biome", ...Deno.args],
    });

const { code } = await cmd.spawn().status;
Deno.exit(code);
