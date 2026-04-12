/**
 * Environment variable abstraction for cross-runtime compatibility
 * Works in both Deno (local development) and Bunny Edge (production)
 *
 * - Deno: uses Deno.env.get()
 * - Bunny Edge: uses process.env (Node.js compatibility)
 *
 * Tests can override values via setGetEnvOverride() without touching the
 * real environment, avoiding split-brain issues between Deno.env and process.env.
 */

declare const Deno:
  | { env: { get(key: string): string | undefined } }
  | undefined;

/** Augment globalThis to include optional process.env (Bunny Edge runtime) */
declare const process: { env: Record<string, string | undefined> } | undefined;

/** Optional test override — when set, getEnv delegates to this function */
let _getEnvOverride: ((key: string) => string | undefined) | null = null;

/** Replace getEnv's implementation for testing. Returns a restore function. */
export const setGetEnvOverride = (
  fn: ((key: string) => string | undefined) | null,
): (() => void) => {
  const prev = _getEnvOverride;
  _getEnvOverride = fn;
  return () => {
    _getEnvOverride = prev;
  };
};

/**
 * Get an environment variable value
 * Checks process.env first (Bunny Edge), falls back to Deno.env (local dev)
 */
export function getEnv(key: string): string | undefined {
  if (_getEnvOverride) return _getEnvOverride(key);

  // Try process.env first (available in Bunny Edge via node:process)
  if (process?.env && key in process.env) {
    return process.env[key];
  }

  // Fall back to Deno.env for local development
  // In Bunny Edge production, process.env is always available (handled above)
  return Deno!.env.get(key);
}

/** Check if the system is in read-only mode (READ_ONLY env var) */
export const isReadOnly = (): boolean => getEnv("READ_ONLY") === "true";

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
