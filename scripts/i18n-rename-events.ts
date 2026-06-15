/**
 * One-shot: rename the events->listings domain in the en locale (keys + values).
 *
 * Main renamed the "event" concept to "listing" (1865 "Listing" vs 68 "Event"
 * survivors). This optimistically renames every event* key to listing* and
 * rewrites "Event(s)"/"event(s)" values to "Listing(s)"/"listing(s)". The ~68
 * survivors where main kept "Event" will be caught per-page by verify-i18n [B]
 * during wiring and fixed individually.
 *
 * Keys: plain replace (locale keys only use "event" for the domain concept).
 * Values: word-boundary replace (avoid "prevent"/"eventually" in prose).
 *
 * Usage: deno run --allow-read --allow-write scripts/i18n-rename-events.ts
 */

const DIR = "src/locales/en";

const renameKey = (k: string): string =>
  k.replace(/events/g, "listings").replace(/event/g, "listing");

const renameValue = (v: string): string =>
  v
    .replace(/\bEvents\b/g, "Listings")
    .replace(/\bEvent\b/g, "Listing")
    .replace(/\bevents\b/g, "listings")
    .replace(/\bevent\b/g, "listing");

let keyCount = 0;
let valCount = 0;
let fileCount = 0;

for (const entry of Deno.readDirSync(DIR)) {
  if (!entry.name.endsWith(".json")) continue;
  const path = `${DIR}/${entry.name}`;
  const obj = JSON.parse(Deno.readTextFileSync(path)) as Record<string, string>;
  const out: Record<string, string> = {};
  let changed = false;
  for (const [k, v] of Object.entries(obj)) {
    const nk = renameKey(k);
    const nv = renameValue(v);
    if (nk !== k) keyCount++;
    if (nv !== v) valCount++;
    if (nk !== k || nv !== v) changed = true;
    out[nk] = nv;
  }
  if (changed) {
    fileCount++;
    Deno.writeTextFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`updated ${entry.name}`);
  }
}

console.log(`\n${fileCount} files, ${keyCount} keys renamed, ${valCount} values rewritten`);
