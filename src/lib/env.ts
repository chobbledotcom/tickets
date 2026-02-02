/**
 * Environment variable abstraction for cross-runtime compatibility
 * Works in both Deno (local development) and Bunny Edge (production)
 *
 * - Deno: uses Deno.env.get()
 * - Bunny Edge: uses process.env (Node.js compatibility)
 */

declare const Deno: { env: { get(key: string): string | undefined } } | undefined;

/**
 * Get an environment variable value
 * Checks process.env first (Bunny Edge), falls back to Deno.env (local dev)
 */
export function getEnv(key: string): string | undefined {
  // Try process.env first (available in Bunny Edge via node:process)
  // deno-lint-ignore no-explicit-any
  const processEnv = (globalThis as any).process?.env;
  if (processEnv && key in processEnv) {
    return processEnv[key];
  }

  // Fall back to Deno.env for local development
  // In Bunny Edge production, process.env is always available (handled above)
  return Deno!.env.get(key);
}
