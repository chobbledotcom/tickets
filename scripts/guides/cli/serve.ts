#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "@std/cli/parse-args";
import { serveDir } from "@std/http/file-server";
/** Serve the packaged guide player on the loopback address for local review.
 * Pair this with `GUIDE_CDN_BASE=http://127.0.0.1:8081 deno task dev`. */
import { join } from "@std/path";
import { projectRoot } from "#scripts/project-root.ts";

const options = parseArgs(Deno.args, { string: ["port", "root"] });
const port = Number(
  options.port ?? Deno.env.get("GUIDE_PREVIEW_PORT") ?? "8081",
);
const root = options.root ?? join(projectRoot, "reports", "guides", "preview");

if (import.meta.main) {
  Deno.serve({ hostname: "127.0.0.1", port }, (request) =>
    serveDir(request, { fsRoot: root, quiet: true }),
  );
  console.log(`Serving ${root} at http://127.0.0.1:${port}/`);
}
