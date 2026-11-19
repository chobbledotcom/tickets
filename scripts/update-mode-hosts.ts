#!/usr/bin/env -S deno run
/**
 * Print the site hosts an update-mode run needs permission for. The deploy
 * workflows call this before they start the update-mode CLI, because a Deno
 * permission must be granted on the command line:
 *
 *   deno run scripts/update-mode-hosts.ts https://site.example
 *
 * The output names the site's stored host and its stable twin. A site on a
 * `.bunny.run` host fetches its `.b-cdn.net` twin, so both need the grant.
 * The caller adds the Bunny API host to the --allow-net value.
 */

import { siteFetchHosts } from "#shared/site-address.ts";

const [siteUrl] = Deno.args;

if (siteUrl === undefined || siteUrl.trim() === "") {
  console.error("Usage: deno run scripts/update-mode-hosts.ts <site-url>");
  Deno.exit(1);
}

console.log(siteFetchHosts(siteUrl).join(","));
