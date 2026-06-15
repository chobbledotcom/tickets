/**
 * Tracks how long the current runtime instance has been alive.
 *
 * `startMs` is captured when this module is first evaluated. On Bunny Edge
 * Scripting that happens at isolate boot (and at process start in local dev).
 * Because module-level state lives for the whole lifetime of the isolate, the
 * reported value grows across every request the same isolate serves and only
 * resets to zero when a fresh isolate starts — making it a cheap, direct
 * measure of how long edge isolates actually live.
 */

const startMs = Date.now();

/** Seconds the current runtime instance has been alive. */
export const getUptimeSeconds = (): number => (Date.now() - startMs) / 1000;
