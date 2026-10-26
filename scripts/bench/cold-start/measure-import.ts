/**
 * Child for the bundle-load benchmark: imports the given bundle fresh and
 * reports the time; with a "request" argument also serves /robots.txt once
 * (never touches the database). Prints one JSON line.
 */

import { bootBundle } from "./boot-bundle.ts";

const [target, mode] = Deno.args;
if (!target) {
  console.error("usage: measure-import.ts <bundle-path> [request]");
  Deno.exit(1);
}

const timings = await bootBundle(
  target,
  mode === "request" ? "request" : "import",
);
console.log(JSON.stringify(timings));
