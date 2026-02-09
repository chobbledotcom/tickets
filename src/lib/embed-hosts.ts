/**
 * Embed host validation and parsing utilities
 */

import { filter, map, pipe } from "#fp";

/**
 * Valid host pattern: a hostname with optional wildcard prefix.
 * Allowed forms:
 *   - "example.com"
 *   - "sub.example.com"
 *   - "*.example.com"
 * Rejects:
 *   - Ports, paths, protocols, spaces
 *   - Bare "*" (too broad)
 *   - "**.example.com" or "*example.com"
 */
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Validate a single host pattern
 * Returns null if valid, or an error message if invalid
 */
export const validateHostPattern = (host: string): string | null => {
  if (host === "") return "Empty host pattern";
  if (host === "*") return "Bare wildcard '*' is not allowed — use '*.example.com'";
  if (!HOST_PATTERN.test(host)) {
    return `Invalid host pattern: '${host}' — must be a hostname like 'example.com' or '*.example.com'`;
  }
  return null;
};

/**
 * Parse a comma-separated list of hosts into trimmed, lowercased entries.
 * Filters out empty strings from trailing commas etc.
 */
export const parseEmbedHosts = (input: string): string[] =>
  pipe(
    map((s: string) => s.trim().toLowerCase()),
    filter((s: string) => s !== ""),
  )(input.split(","));

/**
 * Validate a comma-separated list of host patterns.
 * Returns null if all valid, or the first error message.
 */
export const validateEmbedHosts = (input: string): string | null => {
  const hosts = parseEmbedHosts(input);
  for (const host of hosts) {
    const error = validateHostPattern(host);
    if (error) return error;
  }
  return null;
};

/**
 * Build a frame-ancestors CSP value from allowed embed hosts.
 * Returns null if the list is empty (allow embedding from anywhere).
 */
export const buildFrameAncestors = (hosts: string[]): string | null => {
  if (hosts.length === 0) return null;
  return `frame-ancestors 'self' ${hosts.join(" ")}`;
};
