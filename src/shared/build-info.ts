/**
 * Build metadata injected at build time by build-edge.ts
 * In development, these return empty strings.
 */

/** ISO 8601 timestamp of when the edge bundle was built */
export const BUILD_TIMESTAMP = "";

/** Git commit SHA (short) from CI, empty in dev */
export const BUILD_COMMIT = "";
