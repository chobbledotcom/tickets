/**
 * Shared child runner: spawn a fresh Deno process, parse one JSON line.
 * Cleared environment + small whitelist so the operator's shell cannot
 * change what the measured process boots; a hung child times out loudly.
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
