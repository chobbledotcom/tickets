/**
 * Asset paths with cache-busting support.
 * In dev, paths are plain. At build time, the build script
 * replaces this module to append a build timestamp.
 */

/** CSS stylesheet path, cache-busted at build time */
export const CSS_PATH = "/mvp.css";

/** Admin JS path, cache-busted at build time */
export const JS_PATH = "/admin.js";
