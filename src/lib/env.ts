/**
 * Environment variable abstraction for cross-runtime compatibility
 * Works in both Deno (local development) and Bunny Edge (production)
 *
 * - Deno: uses Deno.env.get()
 * - Bunny Edge: uses process.env (Node.js compatibility)
 *
 * Tests can intercept reads via setGetEnvOverlay() to inject values
 * that are visible to getEnv() without touching the real environment.
 */

declare const Deno:
  | { env: { get(key: string): string | undefined } }
  | undefined;

/** Augment globalThis to include optional process.env (Bunny Edge runtime) */
declare const process: { env: Record<string, string | undefined> } | undefined;

import { lazyRef } from "#fp";

/**
 * Optional test overlay for getEnv(). When set, keys present in the overlay
 * are returned from the overlay; keys NOT in the overlay fall through to
 * the real process.env / Deno.env lookup. This avoids the split-brain where
 * Deno.env patches don't propagate to process.env.
 */
const [getOverlay, setOverlay] = lazyRef<Record<
  string,
  string | undefined
> | null>(() => null);

/** Set a getEnv overlay for testing. Returns a restore function. */
export const setGetEnvOverlay = (
  overlay: Record<string, string | undefined> | null,
): (() => void) => {
  const prev = getOverlay();
  setOverlay(overlay);
  return () => setOverlay(prev);
};

/**
 * Get an environment variable value
 * Checks test overlay first, then process.env (Bunny Edge), then Deno.env
 */
export function getEnv(key: string): string | undefined {
  const overlay = getOverlay();
  if (overlay && key in overlay) return overlay[key];

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
