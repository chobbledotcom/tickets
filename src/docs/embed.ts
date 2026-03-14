/**
 * Embeddable widget: iframe integration and CDN storage.
 *
 * Generates embed snippets (script and iframe variants) for
 * embedding ticket booking on external websites. Includes
 * host validation with wildcard domain support and
 * Content-Security-Policy frame-ancestors headers.
 *
 * @module
 */

export * from "#lib/embed.ts";
export * from "#lib/embed-hosts.ts";
export * from "#lib/iframe.ts";
export * from "#lib/storage.ts";
export * from "#lib/bunny-cdn.ts";
