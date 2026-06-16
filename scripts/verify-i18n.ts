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
    stderr: "null",
    stdout: "piped",
  }).outputSync();
  return success ? new TextDecoder().decode(stdout) : "";
};

/** Does a param-less t() call still remain (i.e. an unreversible ICU/param call)? */
const HAS_T_CALL = /(?<![A-Za-z0-9_$])t\(/;

const usedKeys = (src: string): string[] =>
  [...src.matchAll(T_CALL)].map((m) => m[2]);

/**
 * Reverse a param-less t("key") back to the source it replaced, honouring the
 * three syntactic positions so the result is byte-comparable to origin/main:
 *   attr:  title={t("k")}  -> title="value"
 *   child: >{t("k")}<      -> >value<
 *   bare:  fail(t("k"))    -> fail("value")   (TS string context)
 */
const untranslateLine = (line: string): string =>
  line
    .replace(/=\s*\{\s*t\((["'`])([^"'`]+)\1\)\s*\}/g, (m, _q, k) =>
      k in messages ? `=${JSON.stringify(messages[k])}` : m,
    )
    .replace(/\$?\{\s*t\((["'`])([^"'`]+)\1\)\s*\}/g, (m, _q, k) =>
      k in messages ? messages[k] : m,
    )
    .replace(T_CALL_NOARGS, (m, _q, k) =>
      k in messages ? JSON.stringify(messages[k]) : m,
    );

/** Heuristic scan for user-facing strings that still look hard-coded. */
const leftoverLiterals = (src: string): string[] => {
  const hits: string[] = [];
  const lines = src.split("\n");
  const ATTR =
    /\b(placeholder|title|aria-label|alt|label)\s*=\s*(["'])([^"'{][^"']*)\2/g;
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
    lines.push(
      `  [A] FAIL ${missing.length} unknown key(s): ${missing.join(", ")}`,
    );
  } else {
    lines.push(`  [A] ok    ${keys.length} t() call(s), all keys resolve`);
  }

  // D. Coverage — every key the old branch wired here must be present.
  if (expect.length) {
    const absent = expect.filter((k) => !keySet.has(k));
    if (absent.length) {
      // Soft: main may have removed UI the old branch translated, orphaning a
      // key. Never re-add deleted elements to satisfy this — treat as residue.
      lines.push(
        `  [D] warn  ${absent.length}/${expect.length} expected key(s) not used here (wire if the string exists; else orphaned — main removed it): ${absent.join(", ")}`,
      );
    } else {
      lines.push(`  [D] ok    all ${expect.length} expected key(s) present`);
    }
  }

  // B. English-preserving: for each diff hunk, the added lines (un-translated)
  // must reproduce the removed lines. Compared per-hunk as a whitespace-collapsed
  // block so JSX reflow (biome splitting one line into several) doesn't matter;
  // hunks whose added side still contains an ICU/param call are reported, not
  // failed (those aren't textually reversible).
  const diff = sh("git", [
    "diff",
    "--no-color",
    "-U0",
    "origin/main",
    "--",
    file,
  ]);
  if (!diff.trim()) {
    lines.push("  [B] skip  no changes vs origin/main");
  } else {
    // Reduce a block to comparable English content: unify string delimiters,
    // drop all whitespace (JSX trims it around {expr}/elements) and code
    // structure (brackets/parens and trailing commas) that wiring/biome can
    // add or remove without changing rendered English.
    // TSX decodes HTML entities in source text to characters at compile time
    // (e.g. &mdash; -> —), so decode them here to compare rendered English.
    const nb = (s: string): string =>
      s
        .replace(/&mdash;/g, "—")
        .replace(/&ndash;/g, "–")
        .replace(/&apos;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/[`'"]/g, "")
        .replace(/\s+/g, "")
        .replace(/,(?=[)\]}])/g, "")
        .replace(/[(){}[\]]/g, "");
    type Hunk = { added: string[]; removed: string[] };
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    for (const l of diff.split("\n")) {
      if (l.startsWith("+++") || l.startsWith("---")) continue;
      if (l.startsWith("@@")) {
        cur = { added: [], removed: [] };
        hunks.push(cur);
      } else if (l.startsWith("+")) cur?.added.push(l.slice(1));
      else if (l.startsWith("-")) cur?.removed.push(l.slice(1));
    }
    const mismatches: string[] = [];
    let paramUnverified = 0;
    const isImport = (l: string): boolean => /^\s*import\b/.test(l);
    for (const h of hunks) {
      // Import lines never hold user-facing English (and wiring adds the t
      // import / may reorder others), so compare only non-import lines.
      const added = h.added.filter((a) => !isImport(a));
      const removed = h.removed.filter((r) => !isImport(r));
      if (!added.length && !removed.length) continue; // import-only hunk
      const u = untranslateLine(added.join(" "));
      if (HAS_T_CALL.test(u)) {
        paramUnverified++; // ICU/param call — not textually reversible
        continue;
      }
      if (nb(u) !== nb(removed.join(" "))) {
        mismatches.push(added.join(" ").trim().slice(0, 100));
      }
    }
    if (mismatches.length) {
      hardFail = true;
      lines.push(
        `  [B] FAIL ${mismatches.length} wired hunk(s) don't reproduce origin English (wrong key or stray edit):`,
      );
      for (const m of mismatches.slice(0, 8)) lines.push(`        + ${m}`);
    } else {
      const note = paramUnverified
        ? ` (${paramUnverified} ICU/param hunk(s) not auto-checked — eyeball)`
        : "";
      lines.push(`  [B] ok    English preserved${note}`);
    }
  }

  // C. Leftover literals (warning)
  const leftover = leftoverLiterals(src);
  if (leftover.length) {
    lines.push(`  [C] warn  ${leftover.length} possible un-wired string(s):`);
    lines.push(...leftover.slice(0, 25));
    if (leftover.length > 25)
      lines.push(`  ... and ${leftover.length - 25} more`);
  } else {
    lines.push("  [C] ok    no obvious leftover literals");
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
