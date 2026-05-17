#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * Diagnostic script: prints the storage zones and database regions that
 * Bunny will accept when creating a libSQL database.
 *
 * Hits the same endpoint the `bunny db create` CLI uses internally
 * (GET /database/v1/config) so the values match what the API will
 * actually accept in a create-database request body.
 *
 * Usage: BUNNY_API_KEY=... deno run --allow-net --allow-env scripts/bunny-regions.ts
 */

interface BunnyRegion {
  id: string;
  name: string;
  group: string;
}

interface BunnyConfig {
  storage_region_available: BunnyRegion[];
  primary_regions: BunnyRegion[];
  replica_regions: BunnyRegion[];
}

const apiKey = Deno.env.get("BUNNY_API_KEY");
if (!apiKey) {
  console.error("BUNNY_API_KEY is required");
  Deno.exit(1);
}

const res = await fetch("https://api.bunny.net/database/v1/config", {
  headers: { AccessKey: apiKey },
});

if (!res.ok) {
  console.error(`Bunny config endpoint failed: ${res.status}`);
  console.error(await res.text());
  Deno.exit(1);
}

const config: BunnyConfig = await res.json();

const fmt = (rs: BunnyRegion[]) =>
  rs
    .map((r) => `  ${r.id.padEnd(12)} ${r.group.padEnd(6)} ${r.name}`)
    .join("\n");

console.log("Storage zones (use the id as `storage_region`):");
console.log(fmt(config.storage_region_available));
console.log("\nPrimary regions:");
console.log(fmt(config.primary_regions));
console.log("\nReplica regions:");
console.log(fmt(config.replica_regions));

const eu = (r: BunnyRegion) => r.group === "EU";
console.log("\nEuropean storage zone ids:");
console.log(config.storage_region_available.filter(eu).map((r) => r.id));
console.log("European primary region ids:");
console.log(config.primary_regions.filter(eu).map((r) => r.id));
console.log("European replica region ids:");
console.log(config.replica_regions.filter(eu).map((r) => r.id));
