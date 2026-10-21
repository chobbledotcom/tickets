/**
 * The limit registry: the machinery behind the tunable limit declarations in
 * limits.ts. Each call to {@link limit} or {@link computedLimit} appends one
 * entry to the debug-page table. The table and the named constants share one
 * declaration, so they can never drift.
 */

import { getEnv } from "#shared/env.ts";

/**
 * Parse a string as a positive integer, falling back to the given default
 * if the input is empty, non-numeric, or non-positive.
 */
export const positiveIntOrDefault = (raw: string, fallback: number): number => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Read a limit from an env var with a fallback default.
 * Returns the env value when it parses to a positive integer, otherwise the default.
 */
export const readLimit = (envKey: string, defaultValue: number): number => {
  const raw = getEnv(envKey);
  if (raw === undefined) return defaultValue;
  return positiveIntOrDefault(raw, defaultValue);
};

export type LimitEntry = {
  readonly label: string;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly current: number;
  readonly unit: string;
};

/** The debug-page display list. Entries land here as limits.ts declares its
 * limits. */
const REGISTRY: LimitEntry[] = [];

/** Register a computed limit whose value is derived from another limit. For
 * example, `SCANNER_CSRF_MAX_AGE_S` defaults to `SESSION_MAX_AGE_S`, and
 * `PRUNE_PAYMENTS_RETENTION_DAYS` goes through `assertPaymentsRetentionSafe`.
 * Records its metadata for the debug table and returns the value. */
export const computedLimit = (
  current: number,
  defaultValue: number,
  envKey: string,
  label: string,
  unit: string,
): number => {
  REGISTRY.push({ current, defaultValue, envKey, label, unit });
  return current;
};

/** Declare a tunable limit: read from env with `defaultValue`, register its
 * metadata, and return the resolved value. Each limit is declared exactly
 * once. The named export and the {@link LIMIT_ENTRIES} debug table read the
 * same declaration, so a constant and its table entry can never disagree.
 * A plain env-read limit is just a computed one whose value comes
 * from {@link readLimit}, so it shares that registration path. Exported so a
 * domain module (for example `#shared/square/limits.ts`) can register its own
 * limits into the one shared debug table. */
export const limit = (
  envKey: string,
  defaultValue: number,
  label: string,
  unit: string,
): number =>
  computedLimit(
    readLimit(envKey, defaultValue),
    defaultValue,
    envKey,
    label,
    unit,
  );

/** The debug-page display list, derived from the limit declarations in
 * limits.ts and in the domain modules that load after it. */
export const LIMIT_ENTRIES: readonly LimitEntry[] = REGISTRY;
