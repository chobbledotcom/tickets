/**
 * Shared child-process runner for the cold-start benchmarks.
 *
 * Both drivers measure by spawning fresh Deno processes and parsing one JSON
 * line from stdout. The child runs with a cleared environment plus a small
 * whitelist, so a variable in the operator's shell (SENTRY_URL,
 * MAIN_INSTANCE_KEY, ...) cannot change what the measured process boots or
 * serves — only what Deno itself needs to find its module caches is
 * inherited. A hung child is killed by the timeout and fails the run with
 * its label, instead of blocking the whole benchmark.
 */

const INHERITED_KEYS = ["HOME", "PATH", "DENO_DIR", "DENO_TLS_CA_STORE"];

const childEnv = (extra: Record<string, string>): Record<string, string> => {
  const inherited: Record<string, string> = {};
  for (const key of INHERITED_KEYS) {
    const value = Deno.env.get(key);
    if (value !== undefined) inherited[key] = value;
  }
  return { ...inherited, ...extra };
};

export const spawnChildJson = async <T>(
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  const command = new Deno.Command(Deno.execPath(), {
    args,
    clearEnv: true,
    env: childEnv(extraEnv),
    signal: AbortSignal.timeout(timeoutMs),
    stderr: "inherit",
    stdout: "piped",
  });
  const { code, signal, stdout } = await command.output();
  if (code !== 0) {
    throw new Error(`${label} failed (code=${code}, signal=${signal})`);
  }
  return JSON.parse(new TextDecoder().decode(stdout)) as T;
};
