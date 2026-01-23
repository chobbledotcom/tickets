/**
 * Slug utilities for URL-friendly identifiers
 */

/**
 * Validate a slug format
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens
 */
export const isValidSlug = (slug: string): boolean =>
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
