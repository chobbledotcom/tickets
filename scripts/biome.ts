#!/usr/bin/env -S deno run --allow-all
/**
 * Biome runner that prefers the local native binary.
 *
 * If `biome` exists on PATH, use it. That keeps Nix dev shells on the native
 * package even for CI-style checks. If it is missing, fall back to the npm
 * package so hosted CI can run without a separate Biome install step.
 *
 * Info-level diagnostics are treated as failures: a rule that reports at
 * `info` severity (Biome's default for low-impact suggestions) still points at
 * a fixable issue we want caught rather than slipping past. Biome's own
 * `--error-on-warnings` only elevates `warn`; an `info` finding exits 0. So
 * after Biome runs we scan its summary for "Found N info." and fail the
 * process if N > 0, surfacing each "i" finding as a real lint error.
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
  ? new Deno.Command("biome", {
      args: Deno.args,
      stderr: "piped",
      stdout: "piped",
    })
  : new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "npm:@biomejs/biome", ...Deno.args],
      stderr: "piped",
      stdout: "piped",
    });

const { code, stdout, stderr } = await cmd.output();

// Forward Biome's own output so callers see the diagnostics they printed.
await Deno.stdout.write(stdout);
await Deno.stderr.write(stderr);

// Promote any info-level diagnostic to a hard failure. Biome's
// `--error-on-warnings` lifts `warn` to non-zero in `lint:ci`, but leaves
// `info` non-blocking — by default an "i" finding exits 0. We scan the
// summary line (e.g. "Found 3 info.") so that an info-level rule firing
// breaks the build until the issue is fixed.
const allOutput =
  new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
const infoMatch = /Found (\d+) info\./.exec(allOutput);
const infoCount = infoMatch ? Number.parseInt(infoMatch[1] ?? "0", 10) : 0;
if (infoCount > 0) {
  console.error(
    `Lint failed: ${infoCount} info-level diagnostic${
      infoCount === 1 ? "" : "s"
    } detected (the "i" findings above). Biome does not elevate "info" via --error-on-warnings, so this project treats it as a hard error — fix the issue(s) above.`,
  );
  Deno.exit(1);
}

Deno.exit(code);
