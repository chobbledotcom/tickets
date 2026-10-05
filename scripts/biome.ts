#!/usr/bin/env -S deno run --allow-all
/**
 * Biome runner that prefers the local native binary.
 *
 * If `biome` exists on PATH, use it. That keeps Nix dev shells on the native
 * package even for CI-style checks. If it is missing, fall back to the npm
 * package so hosted CI can run without a separate Biome install step.
 *
 * Strict mode is opt-in via `--error-on-warnings`: the read-only CI posture
 * (`lint:ci`, precommit, and the opencode edit-check pipeline) passes that
 * flag, and only there are info-level diagnostics treated as failures. A
 * rule that reports at `info` severity (Biome's default for low-impact
 * suggestions) still points at an issue we want caught rather than slipping
 * past. Biome's own `--error-on-warnings` only elevates `warn`; an `info`
 * finding exits 0. So in strict mode we scan Biome's summary for
 * "Found N info." and fail the process if N > 0, surfacing each "i" finding
 * as a real lint error. The auto-fixing `lint` task omits the flag: it
 * self-heals what it can at save time and leaves warn/info findings to the
 * strict gate instead of failing.
 *
 * Usage: deno run -A scripts/biome.ts <biome args...>
 */

import { resolveBiomeCommand } from "./biome-command.ts";

const piped = { stderr: "piped", stdout: "piped" } as const;
const resolved = await resolveBiomeCommand(Deno.args);
const cmd = new Deno.Command(resolved.command, {
  args: resolved.args,
  ...piped,
});

const { code, stdout, stderr } = await cmd.output();

// Forward Biome's own output so callers see the diagnostics they printed.
await Deno.stdout.write(stdout);
await Deno.stderr.write(stderr);

// Promote any info-level diagnostic to a hard failure — in strict mode
// only (`--error-on-warnings` present). Biome's `--error-on-warnings` lifts
// `warn` to non-zero in `lint:ci`, but leaves `info` non-blocking — by
// default an "i" finding exits 0. We scan the summary line (e.g.
// "Found 3 info.") so that an info-level rule firing breaks a strict run
// until the issue is fixed. Non-strict fix runs (the auto-fixing `lint`
// task) leave info findings to the strict gate.
const strict = Deno.args.includes("--error-on-warnings");
const allOutput =
  new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
const infoMatch = /Found (\d+) info\./.exec(allOutput);
const infoCount = infoMatch ? Number.parseInt(infoMatch[1] ?? "0", 10) : 0;
if (strict && infoCount > 0) {
  console.error(
    `Lint failed: ${infoCount} info-level diagnostic${
      infoCount === 1 ? "" : "s"
    } detected (the "i" findings above). Biome does not elevate "info" via --error-on-warnings, so this project treats it as a hard error — fix the issue(s) above.`,
  );
  Deno.exit(1);
}

Deno.exit(code);
