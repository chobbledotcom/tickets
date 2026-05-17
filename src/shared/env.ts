/**
 * Environment variable abstraction for cross-runtime compatibility
 * Works in both Deno (local development) and Bunny Edge (production)
 *
 * - Deno: uses Deno.env.get()
 * - Bunny Edge: uses process.env (Node.js compatibility)
 *
 * Note: In Deno, process.env is a proxy over Deno.env — they share the
 * same backing store. The test overlay (setTestEnv in test-utils) patches
 * Deno.env.get/set/delete, which automatically affects process.env reads
 * and writes too.
 */

declare const Deno:
  | { env: { get(key: string): string | undefined } }
  | undefined;

/** Augment globalThis to include optional process.env (Bunny Edge runtime) */
declare const process: { env: Record<string, string | undefined> } | undefined;

/**
 * Get an environment variable value
 * Checks process.env first (Bunny Edge), falls back to Deno.env (local dev)
 */
export function getEnv(key: string): string | undefined {
  // Try process.env first (available in Bunny Edge via node:process)
  if (process?.env && key in process.env) {
    return process.env[key];
  }

  // Fall back to Deno.env for local development
  // In Bunny Edge production, process.env is always available (handled above)
  return Deno!.env.get(key);
}

/** Parse a string into a positive integer for warning days. Returns defaultVal on bad input. */
export const parseWarnDays = (
  raw: string | undefined,
  defaultVal = 14,
): number => {
  if (!raw) return defaultVal;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return n;
};

/** Pure helper: is the site read-only based on a cutoff timestamp? */
export const isReadOnlyFromCutoff = (now: number, cutoff: string): boolean => {
  const parsed = Date.parse(cutoff);
  if (Number.isNaN(parsed)) return false;
  return now >= parsed;
};

/** Pure helper: is the current time within the warning window before cutoff? */
export const isInWarningWindow = (
  now: number,
  cutoff: string,
  warnDays: number,
): boolean => {
  const parsed = Date.parse(cutoff);
  if (Number.isNaN(parsed)) return false;
  return now >= parsed - warnDays * 86_400_000 && now < parsed;
};

/** Check if the system is in read-only mode (READ_ONLY env var or READ_ONLY_FROM cutoff) */
export const isReadOnly = (): boolean => {
  if (getEnv("READ_ONLY") === "true") return true;
  const cutoff = getEnv("READ_ONLY_FROM");
  if (!cutoff) return false;
  if (Number.isNaN(Date.parse(cutoff))) {
    void (async () => {
      const { ErrorCode, logError } = await import("#shared/logger.ts");
      logError({
        code: ErrorCode.DATA_INVALID,
        detail: `READ_ONLY_FROM unparseable: ${cutoff}`,
      });
    })();
    return false;
  }
  return isReadOnlyFromCutoff(Date.now(), cutoff);
};

/** Check if the site should show a pre-expiry warning banner */
export const isReadOnlyWarning = (): boolean => {
  if (isReadOnly()) return false;
  const cutoff = getEnv("READ_ONLY_FROM");
  if (!cutoff) return false;
  const warnDays = parseWarnDays(getEnv("READ_ONLY_WARN_DAYS"));
  return isInWarningWindow(Date.now(), cutoff, warnDays);
};

/** Get the READ_ONLY_FROM cutoff ISO string, or null if not set */
export const getReadOnlyCutoffIso = (): string | null => {
  const cutoff = getEnv("READ_ONLY_FROM");
  if (!cutoff) return null;
  const parsed = Date.parse(cutoff);
  return Number.isNaN(parsed) ? null : cutoff;
};

/** Get the RENEWAL_URL, or null if not set */
export const getRenewalUrl = (): string | null => getEnv("RENEWAL_URL") ?? null;

/**
 * Get a required environment variable, throwing if not set.
 * Use this instead of `getEnv(key) as string` when the variable must exist.
 */
export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (value === undefined) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}
