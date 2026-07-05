#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-run --allow-sys --allow-ffi
/**
 * One-off CLI: provision a new Tickets site on Bunny via the existing
 * builder pipeline (Bunny database + edge script + secrets + publish),
 * deploying a fresh local bundle instead of the latest GitHub release.
 *
 * Reuses `builderApi.buildSite` from src/shared/builder.ts. The admin
 * /admin/builder route continues to use the GitHub release path; only
 * this CLI passes the locally-built bundle via the `code` parameter.
 *
 * Usage:
 *   BUNNY_API_KEY=... deno run --allow-all scripts/build-site.ts "My Event Site"
 */

import { builderApi } from "#shared/builder.ts";

const [siteName] = Deno.args;
if (!siteName) {
  console.error("Usage: build-site.ts <site-name>");
  Deno.exit(1);
}

if (!Deno.env.get("BUNNY_API_KEY")) {
  console.error("BUNNY_API_KEY env var is required");
  Deno.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;
const bundlePath = `${repoRoot}bunny-script.ts`;

console.log("Building edge bundle…");
const build = await new Deno.Command(Deno.execPath(), {
  args: ["task", "build:edge"],
  cwd: repoRoot,
  stderr: "inherit",
  stdout: "inherit",
}).output();
if (!build.success) {
  console.error("build:edge failed");
  Deno.exit(build.code);
}

const code = await Deno.readTextFile(bundlePath);
console.log(
  `Bundle ready (${code.length} bytes). Provisioning site "${siteName}"…`,
);

const result = await builderApi.buildSite({ code, siteName });

if (!result.ok) {
  console.error(`Build failed: ${result.error}`);
  Deno.exit(1);
}

console.log("Site built successfully:");
console.log(`  hostname:  https://${result.defaultHostname}`);
console.log(`  hostingId: ${result.hostingId}`);
console.log(`  dbUrl:     ${result.dbUrl}`);
console.log(`  dbToken:   ${result.dbToken}`);
