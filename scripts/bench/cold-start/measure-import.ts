/**
 * Child for the bundle-load benchmark: imports the given bundle fresh and
 * reports the time; with a "request" argument also serves /robots.txt once
 * (never touches the database). Prints one JSON line.
 */

import { toFileUrl } from "@std/path";

const [target, mode] = Deno.args;
if (!target) {
  console.error("usage: measure-import.ts <bundle-path> [request]");
  Deno.exit(1);
}

// performance.now() counts from process start, so this first reading is the
// Deno runtime's own startup cost (before any app code ran).
const runtimeBootMs = performance.now();

// The bundle logs its own startup lines (console.log/debug both go to
// stdout); keep stdout clean for the JSON result the driver parses.
const realLog = console.log.bind(console);
console.log = () => {};
console.debug = () => {};

const importStart = performance.now();
const module = await import(toFileUrl(await Deno.realPath(target)).href);
const importMs = performance.now() - importStart;

let firstRequestMs: number | null = null;
if (mode === "request") {
  const requestStart = performance.now();
  const response: Response = await module.serveHandler(
    new Request("http://localhost/robots.txt"),
  );
  await response.text();
  firstRequestMs = performance.now() - requestStart;
  // A boot or routing error comes back as an error page, and timing an error
  // page is not a benchmark result — fail the run instead.
  if (response.status !== 200) {
    console.error(`first request failed with status ${response.status}`);
    Deno.exit(1);
  }
}

realLog(JSON.stringify({ firstRequestMs, importMs, runtimeBootMs }));
