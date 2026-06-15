/**
 * verify-i18n — per-page translation gate for the i18n re-wiring effort.
 *
 * Usage: deno run --allow-read --allow-run scripts/verify-i18n.ts <file> [<file>...]
 *
 * Runs three checks per file:
 *   A. Key resolution (HARD)   — every t("key") used resolves in the en locale.
 *   B. English-preserving (HARD)— the page's rendered English is unchanged vs
 *                                 origin/main: each param-less t("key") must map
 *                                 back to the exact literal it replaced. Computed
 *                                 by "un-translating" the wired file and diffing
 *                                 against the pristine origin/main version.
 *   C. Leftover literals (WARN)— user-facing strings that still look hard-coded.
 *
 * Exit code is non-zero if any HARD check fails on any file.
 */

import en from "#locales/en/index.ts";

const messages = en as Record<string, string>;

/** Matches t("key"), t('key'), t(`key`) — not preceded by an identifier char. */
const T_CALL = /(?<![A-Za-z0-9_$])t\(\s*(["'`])([^"'`]+)\1/g;

/** A t("key") with NO further arguments (param-less, safe to reverse-substitute). */
const T_CALL_NOARGS = /(?<![A-Za-z0-9_$])t\(\s*(["'`])([^"'`]+)\1\s*\)/g;

type Result = { file: string; hardFail: boolean; lines: string[] };

const sh = (cmd: string, args: string[]): string => {
  const { stdout, success } = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  return success ? new TextDecoder().decode(stdout) : "";
};

/** Best-effort: the pristine origin/main version of a path (empty if new file). */
const pristine = (path: string): string => sh("git", ["show", `origin/main:${path}`]);

/** Normalise for comparison: drop the t-import line, collapse whitespace. */
const normalise = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*import\s+\{[^}]*\bt\b[^}]*\}\s+from\s+["']#i18n["'];?\s*$/.test(l))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

const usedKeys = (src: string): string[] =>
  [...src.matchAll(T_CALL)].map((m) => m[2]);

/** Replace each param-less t("k") with its en value, so we can compare to origin. */
const untranslate = (src: string): string =>
  src.replace(T_CALL_NOARGS, (whole, _q, key) =>
    key in messages ? messages[key] : whole,
  );

/** Heuristic scan for user-facing strings that still look hard-coded. */
const leftoverLiterals = (src: string): string[] => {
  const hits: string[] = [];
  const lines = src.split("\n");
  const ATTR = /\b(placeholder|title|aria-label|alt|label)\s*=\s*(["'])([^"'{][^"']*)\2/g;
  // JSX text node: >Word(s)< — capitalised, contains a lowercase letter. Single
  // words count (e.g. button labels like "Login"); {expr} children are excluded
  // because they start with "{", not a letter.
  const TEXT = />\s*([A-Z][A-Za-z][A-Za-z ,.'!?&():-]{1,})\s*</g;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ATTR)) {
      hits.push(`  L${i + 1} attr ${m[1]}="${m[3]}"`);
    }
    for (const m of line.matchAll(TEXT)) {
      const text = m[1].trim();
      if (/[a-z]/.test(text)) hits.push(`  L${i + 1} text "${text}"`);
    }
  });
  return hits;
};

const check = (file: string, expect: string[]): Result => {
  const lines: string[] = [];
  let hardFail = false;

  const src = Deno.readTextFileSync(file);
  const keys = usedKeys(src);
  const keySet = new Set(keys);

  // A. Key resolution
  const missing = [...new Set(keys.filter((k) => !(k in messages)))];
  if (missing.length) {
    hardFail = true;
    lines.push(`  [A] FAIL ${missing.length} unknown key(s): ${missing.join(", ")}`);
  } else {
    lines.push(`  [A] ok    ${keys.length} t() call(s), all keys resolve`);
  }

  // D. Coverage — every key the old branch wired here must be present.
  if (expect.length) {
    const absent = expect.filter((k) => !keySet.has(k));
    if (absent.length) {
      hardFail = true;
      lines.push(`  [D] FAIL ${absent.length}/${expect.length} expected key(s) missing: ${absent.join(", ")}`);
    } else {
      lines.push(`  [D] ok    all ${expect.length} expected key(s) present`);
    }
  }

  // B. English-preserving (only when the file exists on origin/main)
  const origin = pristine(file);
  if (origin) {
    const got = normalise(untranslate(src));
    const want = normalise(origin);
    if (got === want) {
      lines.push(`  [B] ok    rendered English matches origin/main`);
    } else {
      hardFail = true;
      lines.push(`  [B] FAIL  English output differs from origin/main (a t() key maps`);
      lines.push(`            to different text, or content was edited). Diff the`);
      lines.push(`            un-translated file against 'git show origin/main:${file}'.`);
    }
  } else {
    lines.push(`  [B] skip  no origin/main baseline (new file)`);
  }

  // C. Leftover literals (warning)
  const leftover = leftoverLiterals(src);
  if (leftover.length) {
    lines.push(`  [C] warn  ${leftover.length} possible un-wired string(s):`);
    lines.push(...leftover.slice(0, 25));
    if (leftover.length > 25) lines.push(`  ... and ${leftover.length - 25} more`);
  } else {
    lines.push(`  [C] ok    no obvious leftover literals`);
  }

  return { file, hardFail, lines };
};

const expectArg = Deno.args.find((a) => a.startsWith("--expect="));
const expect = expectArg
  ? expectArg.slice("--expect=".length).split(",").filter(Boolean)
  : [];
const files = Deno.args.filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: verify-i18n.ts [--expect=k1,k2] <file> [<file>...]");
  Deno.exit(2);
}

let anyFail = false;
for (const file of files) {
  const r = check(file, expect);
  anyFail = anyFail || r.hardFail;
  console.log(`${r.hardFail ? "✗" : "✓"} ${r.file}`);
  for (const l of r.lines) console.log(l);
}
Deno.exit(anyFail ? 1 : 0);
