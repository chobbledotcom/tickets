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

export * from "#shared/bunny-cdn.ts";
export * from "#shared/embed.ts";
export * from "#shared/embed-hosts.ts";
export * from "#shared/iframe.ts";
export * from "#shared/storage.ts";
