/**
 * Environment for benchmark child processes.
 *
 * Children run with `clearEnv: true` plus this whitelist, so a variable in
 * the operator's shell (SENTRY_URL, MAIN_INSTANCE_KEY, ...) cannot change
 * what the measured process boots or serves — repeated runs stay comparable.
 * Only what Deno itself needs to find its module caches is inherited.
 */
export const benchChildEnv = (
  extra: Record<string, string>,
): Record<string, string> => {
  const inherited: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "DENO_DIR", "DENO_TLS_CA_STORE"]) {
    const value = Deno.env.get(key);
    if (value !== undefined) inherited[key] = value;
  }
  return { ...inherited, ...extra };
};
