/**
 * Shared command spawning for the script runners.
 *
 * `commandExitCode` runs any command to completion and returns just its exit
 * code; `denoNpmArgs` builds the `["run", "-A", "npm:<pkg>", …]` argument list
 * so the wrappers that shell out to an npm CLI (Biome, jscpd) spell that
 * scaffold in one place.
 */

/** Run `command` with `options` to completion and return its exit code. */
export const commandExitCode = async (
  command: string,
  options: Deno.CommandOptions,
): Promise<number> => {
  const { code } = await new Deno.Command(command, options).output();
  return code;
};

/** Run `command` to completion, capturing its exit code and its stdout plus
 *  stderr text, so a failed child can say what broke. */
export const commandDetail = async (
  command: string,
  options: Deno.CommandOptions,
): Promise<{ code: number; output: string }> => {
  const { code, stdout, stderr } = await new Deno.Command(command, {
    ...options,
    stderr: "piped",
    stdout: "piped",
  }).output();
  const decoded = new TextDecoder();
  return { code, output: `${decoded.decode(stdout)}${decoded.decode(stderr)}` };
};

/** The `deno run -A npm:<pkg> …` argument list, ready to hand to a Deno
 * command's `args`. */
export const denoNpmArgs = (pkg: string, extraArgs: string[]): string[] => [
  "run",
  "-A",
  `npm:${pkg}`,
  ...extraArgs,
];
