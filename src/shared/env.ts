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
