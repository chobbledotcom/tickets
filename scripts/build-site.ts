#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-sys --allow-ffi
/**
 * One-off CLI: provision a new Tickets site on Bunny via the existing
 * builder pipeline (Bunny database + edge script + secrets + publish).
 *
 * Reuses `builderApi.buildSite` from src/shared/builder.ts so the script
 * stays in sync with the admin /admin/builder flow.
 *
 * Usage: BUNNY_API_KEY=... deno run --allow-net --allow-env --allow-read \
 *          --allow-sys --allow-ffi scripts/build-site.ts "My Event Site"
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

console.log(`Building site "${siteName}"…`);
const result = await builderApi.buildSite({ siteName });

if (!result.ok) {
  console.error(`Build failed: ${result.error}`);
  Deno.exit(1);
}

console.log("Site built successfully:");
console.log(`  hostname:  https://${result.defaultHostname}`);
console.log(`  scriptId:  ${result.scriptId}`);
console.log(`  dbUrl:     ${result.dbUrl}`);
console.log(`  dbToken:   ${result.dbToken}`);
