/**
 * i18n-match — value-matching packet generator for files NOT in the old branch
 * (e.g. main's split settings/ components). Instead of an old-branch diff, it
 * matches each user-facing literal in the file to a locale key whose English
 * value is identical, and writes a packet with that literal→key mapping.
 *
 * Usage: deno run -A scripts/i18n-match.ts <file> [<file>...]
 */

import en from "#locales/en/index.ts";

const messages = en as Record<string, string>;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// normalized English value -> matching key(s)
const byValue = new Map<string, string[]>();
for (const [k, v] of Object.entries(messages)) {
  const n = norm(v);
  const arr = byValue.get(n);
  if (arr) arr.push(k);
  else byValue.set(n, [k]);
}

const slug = (p: string) => p.replace(/[/.]/g, "__");
Deno.mkdirSync(".i18n-work", { recursive: true });

for (const file of Deno.args) {
  const src = Deno.readTextFileSync(file);
  const cands = new Set<string>();
  // JSX text nodes: >text<  (must contain a letter, no braces/tags inside)
  for (const m of src.matchAll(/>\s*([^<>{}]*?[A-Za-z][^<>{}]*?)\s*</g)) {
    cands.add(m[1].trim());
  }
  // String/attr literals: "...", '...', `...` containing a letter (no ${} interp)
  for (const m of src.matchAll(/(["'`])([^"'`\n$]*[A-Za-z][^"'`\n$]*)\1/g)) {
    cands.add(m[2].trim());
  }

  const matched: string[] = [];
  const unmatched: string[] = [];
  const keys: string[] = [];
  for (const c of [...cands].sort()) {
    const hit = byValue.get(norm(c));
    if (hit) {
      const flag = hit.length > 1 ? ` (AMBIGUOUS: ${hit.join(", ")})` : "";
      matched.push(`- "${c}"  ->  t("${hit[0]}")${flag}`);
      keys.push(hit[0]);
    } else if (/[a-z].*[a-z]/.test(c) && c.length > 2) {
      unmatched.push(`- "${c}"`);
    }
  }

  const verify = `deno run --allow-read --allow-run scripts/verify-i18n.ts ${file}`;
  const packet = `# i18n value-match packet: ${file}

EDIT THIS FILE: ${file}

This file is new on main (no old-branch diff). Add \`import { t } from "#i18n";\`
and apply the literal→key replacements below — these are EXACT value matches
against the locale. To embed t() in a double-quoted string, switch to a backtick
template. If a value contains HTML, render via <Raw html={t(...)} />. Change
nothing else; DO NOT edit src/locales/. For AMBIGUOUS matches, pick the key
whose namespace fits this file.

## Literal → key (apply these)
${matched.join("\n") || "(none matched)"}

## Verify (must exit 0, [A] and [B] = ok)
${verify}

## User-facing strings with NO matching key (leave as literals, report)
${unmatched.join("\n") || "(none)"}
`;
  Deno.writeTextFileSync(`.i18n-work/${slug(file)}.md`, packet);
  console.log(`${file}\t${keys.length} matched, ${unmatched.length} unmatched`);
}
