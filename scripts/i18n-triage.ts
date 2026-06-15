/**
 * i18n-triage — classify each un-wired page by how much its locale has drifted
 * from main, to route work: low drift -> fleet (Haiku), high drift / events->
 * listings -> manual reconciliation.
 *
 * For each page, take the keys the old branch wired, look up their current en
 * values, and check whether each value's text still appears verbatim in main's
 * file. Values with ICU params ({…}) are skipped (not verbatim by nature).
 *
 * Usage: deno run -A scripts/i18n-triage.ts
 */

import en from "#locales/en/index.ts";

const messages = en as Record<string, string>;
const OLD_BRANCH = "f11b274";

// Reuse the same mapping as the packet generator.
const MAP: Record<string, string> = JSON.parse(
  Deno.readTextFileSync(new URL("./i18n-map.json", import.meta.url)),
);

const sh = (cmd: string, args: string[]): string =>
  new TextDecoder().decode(
    new Deno.Command(cmd, {
      args,
      stderr: "null",
      stdout: "piped",
    }).outputSync().stdout,
  );

const T_CALL = /(?<![A-Za-z0-9_$])t\(\s*(["'`])([^"'`]+)\1/g;
const mb = sh("git", ["merge-base", "origin/main", OLD_BRANCH]).trim();
const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();

type Row = {
  page: string;
  total: number;
  clean: number;
  drift: string[];
  ev: boolean;
};
const rows: Row[] = [];

for (const [oldPath, newPath] of Object.entries(MAP)) {
  const guide = sh("git", ["diff", mb, OLD_BRANCH, "--", oldPath]);
  const keys = [...new Set([...guide.matchAll(T_CALL)].map((m) => m[2]))];
  let main = "";
  try {
    main = squash(sh("git", ["show", `origin/main:${newPath}`]));
  } catch {
    main = "";
  }
  const drift: string[] = [];
  let ev = false;
  for (const k of keys) {
    const v = messages[k] ?? "";
    if (/event|listing/i.test(v) || /event|listing/i.test(k)) ev = true;
    if (v.includes("{")) continue; // ICU/param — not verbatim
    if (!main.includes(squash(v))) drift.push(k);
  }
  rows.push({
    clean: keys.length - drift.length,
    drift,
    ev,
    page: newPath,
    total: keys.length,
  });
}

rows.sort((a, b) => a.drift.length - b.drift.length);
console.log("page\tkeys\tclean\tdrift\tevents?");
for (const r of rows) {
  console.log(
    `${r.page.replace("src/", "")}\t${r.total}\t${r.clean}\t${r.drift.length}\t${r.ev ? "EVENTS" : ""}`,
  );
}
const fleetable = rows.filter((r) => r.drift.length === 0 && !r.ev);
console.log(`\nFLEET-ABLE (0 drift, no events): ${fleetable.length}`);
console.log(fleetable.map((r) => r.page.replace("src/", "")).join("\n"));
