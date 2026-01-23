/**
 * Slug utilities for URL-friendly identifiers
 */

/**
 * Convert a string to a URL-friendly slug
 * - Converts to lowercase
 * - Replaces spaces and non-alphanumeric characters with hyphens
 * - Removes consecutive hyphens
 * - Trims hyphens from start/end
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Validate a slug format
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens
 */
export const isValidSlug = (slug: string): boolean =>
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
