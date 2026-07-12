/**
 * Content-type header values for the static assets we serve.
 *
 * These live in their own tiny module with no imports so the build script can
 * read them without pulling in the runtime asset handlers (which read generated
 * files at load time and reach the database client).
 */

export const JS = "application/javascript; charset=utf-8";
export const CSS = "text/css; charset=utf-8";
export const SVG = "image/svg+xml";
export const TEXT = "text/plain; charset=utf-8";
