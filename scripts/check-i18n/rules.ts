/**
 * Per-file detection of hard-coded user-facing strings: the rule behind
 * test/scripts/i18n-coverage.test.ts and the grader's i18n_catalog check.
 * The gate lives in that test, which also scans the whole tree in both
 * directions; this module holds the per-file rule both callers share.
 */

/** t("key") / t('key') / t(`key`) not preceded by an identifier char. */
export const T_CALL = /(?<![A-Za-z0-9_$])t\(\s*(["'`])([^"'`]+)\1/g;

/** Hard-coded user-facing JSX attribute values. */
const ATTR =
  /\b(placeholder|title|aria-label|alt|label)\s*=\s*(["'])([^"'{][^"']*)\2/g;
/** Hard-coded user-facing object-property values in copy definition modules. */
const PROP =
  /\b(placeholder|title|label|hint|hintHtml|legend|summary|description|header|empty|emptyText)\s*:\s*(["'])([^"'{][^"']*)\2/g;
/** Table configs are object properties in both .ts and .tsx. Quoted values
 * sit on one line; template values are scanned whole-file below, because a
 * header often holds a row or attendee name and may span lines or carry a
 * quoted fallback inside its interpolation. */
const TABLE_PROP_QUOTED =
  /\b(header|empty|emptyText)\s*:\s*(["'])([^"'{][^"']*)\2/g;
const TABLE_PROP_TEMPLATE = /\b(header|empty|emptyText)\s*:\s*`([^`{][^`]*)`/g;
/** JSX text node: capitalised words containing a lowercase letter. The (?<!=)
 * skips `=> Foo<…>` arrow-return generics, which are types, not copy. */
const TEXT = /(?<!=)>\s*([A-Z][A-Za-z][A-Za-z ,.'!?&():-]{1,})\s*</g;

/** Copy-bearing modules outside src/ui/templates that must also be kept honest:
 * the shared form framework renders its own labels and submit buttons. */
export const EXTRA_SCAN_FILES = [
  "src/shared/forms/message-fields.tsx",
  "src/shared/forms/rendering.tsx",
  "src/shared/forms/submitted-value.ts",
  "src/shared/forms/validation.ts",
];

/** The template tree the backward scan walks. */
export const TEMPLATES_DIR = "src/ui/templates";

/** Files (relative to src/) with hard-coded user-facing strings still pending
 * i18n wiring, mapped to the exact number of leftover literals each still has.
 * Wire a file's strings with t(), then lower its number — or delete the entry
 * once it reaches zero. The number may never go up. */
export const LEFTOVER_ALLOWLIST = new Map<string, number>([
  ["shared/forms/message-fields.tsx", 1],
  ["shared/forms/rendering.tsx", 4],
  ["ui/templates/admin/api-keys.tsx", 2],
  ["ui/templates/admin/calendar.tsx", 1],
  ["ui/templates/admin/guide/email.tsx", 4],
  ["ui/templates/admin/guide/accounts.tsx", 3],
  ["ui/templates/admin/guide/domains.tsx", 2],
  ["ui/templates/admin/guide/listings.tsx", 1],
  ["ui/templates/admin/guide/operations.tsx", 1],
  ["ui/templates/admin/guide/integrations.tsx", 6],
  ["ui/templates/admin/guide/payments.tsx", 2],
  ["ui/templates/admin/guide/tickets.tsx", 11],
  ["ui/templates/admin/listings/form-values.tsx", 1],
  ["ui/templates/admin/questions.tsx", 2],
  ["ui/templates/admin/sessions.tsx", 1],
  ["ui/templates/admin/settings/apple-wallet.tsx", 1],
  ["ui/templates/admin/settings/email.tsx", 1],
  ["ui/templates/admin/settings/google-wallet.tsx", 1],
  ["ui/templates/admin/settings/payment.tsx", 6],
  ["ui/templates/admin/site.tsx", 2],
  ["ui/templates/email/defaults.ts", 12],
  ["ui/templates/fields/add-attendee.ts", 3],
  ["ui/templates/fields/listing.ts", 4],
  ["ui/templates/fields/modifier.ts", 20],
  ["ui/templates/fields/ticket.ts", 5],
]);

/** Comment lines never render to users, so strings in them aren't leftovers. */
const isCommentLine = (line: string): boolean => {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

/** Prose needing translation has a lowercase letter; bare numbers/symbols
 * (placeholder="0", "ID", "£") are locale-independent and don't count. */
const wordy = (s: string): boolean =>
  /[a-z]/.test(s.replaceAll(/\$\{[^}]*\}/g, ""));

/** One match as its reader-facing report line. */
type MatchLabel = (
  m: RegExpMatchArray,
  value: string,
  lineNo: number,
) => string;

/** Wordy matches of `re`, each reported through `label` with its line number.
 * `lineAt` derives the number from the match start, so one scan serves a
 * single line (a fixed number) and a whole file (counted from the newlines
 * before the match). `valueOf` returns the user-facing value, or "" to drop
 * the match. */
const wordyMatches = (
  src: string,
  re: RegExp,
  valueFrom: (m: RegExpMatchArray) => string,
  lineAt: (start: number) => number,
  label: MatchLabel,
): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    const value = valueFrom(m);
    if (wordy(value)) out.push(label(m, value, lineAt(m.index)));
  }
  return out;
};

const matchesOnLine = (
  line: string,
  lineNo: number,
  re: RegExp,
  valueGroup: number,
  label: MatchLabel,
): string[] =>
  wordyMatches(
    line,
    re,
    (m) => m[valueGroup]!,
    () => lineNo,
    label,
  );

/** Hard-coded strings in JSX attributes and text nodes on one line. */
const jsxLeftovers = (line: string, lineNo: number): string[] => [
  ...matchesOnLine(line, lineNo, ATTR, 3, (m, v, n) => `L${n} ${m[1]}="${v}"`),
  ...matchesOnLine(
    line,
    lineNo,
    TEXT,
    1,
    (_m, v, n) => `L${n} text "${v.trim()}"`,
  ),
];

/** One object-property hit as the reader-facing line. */
const propHit: MatchLabel = (m, value, lineNo) =>
  `L${lineNo} ${m[1]}: "${value}"`;

/** Hard-coded strings in object-property definitions on one line. TS copy
 * modules use the full property set; TSX adds table configs to its JSX scan.
 * Table templates are scanned whole-file below, so both file kinds see them
 * without a value being counted twice. */
const propLeftovers = (line: string, lineNo: number, isTs: boolean): string[] =>
  matchesOnLine(line, lineNo, isTs ? PROP : TABLE_PROP_QUOTED, 3, propHit);

/** Table template strings, scanned across lines: a template's value may hold
 * a newline, which the per-line pass cannot see. The line number stays the
 * opening line, and a match opening on a comment line is dropped — its
 * example is prose, not copy. */
const templatePropLeftovers = (src: string): string[] =>
  wordyMatches(
    src,
    TABLE_PROP_TEMPLATE,
    (m) => {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      if (isCommentLine(src.slice(lineStart, m.index))) return "";
      // The template regex captures the value in every match.
      return m[2]!.replaceAll(/\s+/g, " ").trim();
    },
    (start) => src.slice(0, start).split("\n").length,
    propHit,
  );

/** The response helpers whose second argument is a flash message. ok and
 * fail wrap redirect in src/shared/response.ts. */
const FLASH_CALL =
  /(?<![A-Za-z0-9_$.])(errorRedirect|infoRedirect|redirect|ok|fail)\(/g;

/** A message argument that is exactly one string or template literal. */
const BARE_LITERAL =
  /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)$/;

/** One call argument: its text and where the text starts in the source. */
type CallArg = { start: number; text: string };

/** Quote, bracket, and closer characters, as flat membership sets so the
 * argument walk stays a short chain of checks. */
const QUOTES = "\"'`";
const OPENERS = "([{";
const CLOSERS = ")]}";

/** The index of the quote that closes the region opening at `open`, or the
 * source length when the source ends first, so the walk stops on its own. */
const closeQuoteAt = (src: string, open: number): number => {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === src[open]) return i;
  }
  return src.length;
};

/** One bracket character's effect on nesting depth: +1, -1, or 0. */
const depthStep = (ch: string): number =>
  OPENERS.includes(ch) ? 1 : CLOSERS.includes(ch) ? -1 : 0;

/** Reads a call's top-level arguments, honouring strings and nesting. Returns
 * null when the call never closes, so a broken match never reports. */
const topLevelArgs = (src: string, open: number): CallArg[] | null => {
  const args: CallArg[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (QUOTES.includes(ch)) {
      i = closeQuoteAt(src, i);
      continue;
    }
    depth += depthStep(ch);
    const closesCall = depth === 0;
    const splitsArgs = ch === "," && depth === 1;
    if (closesCall || splitsArgs) {
      args.push({ start, text: src.slice(start, i) });
    }
    if (closesCall) return args;
    if (splitsArgs) start = i + 1;
  }
  return null;
};

/** The hard-coded flash messages one route source still passes to redirect,
 * errorRedirect, or infoRedirect. The message is the second argument, so the
 * scan reads that argument alone: a quoted path in the first argument and a
 * quoted option value later never count. The argument counts only when it is
 * exactly one string or template literal, so a t() call, a ternary of t()
 * calls, and a variable all pass. */
export const flashLiterals = (src: string): string[] => {
  const hits: string[] = [];
  for (const call of src.matchAll(FLASH_CALL)) {
    const lineStart = src.lastIndexOf("\n", call.index) + 1;
    if (isCommentLine(src.slice(lineStart, call.index))) continue;
    const message = topLevelArgs(src, call.index + call[1]!.length)?.[1];
    if (message === undefined) continue;
    const lead = message.text.length - message.text.trimStart().length;
    const literal = message.text.trim().match(BARE_LITERAL);
    if (literal === null) continue;
    // The match exists, so exactly one quote-style group holds the text.
    const value = (literal[1] ?? literal[2] ?? literal[3])!.trim();
    if (!wordy(value)) continue;
    const at = message.start + lead + literal.index!;
    const line = src.slice(0, at).split("\n").length;
    hits.push(`L${line} flash "${value}"`);
  }
  return hits;
};

/** Hard-coded user-facing strings still present in a file's source. */
export const leftoverLiterals = (src: string, isTs: boolean): string[] => {
  const hits: string[] = [];
  src.split("\n").forEach((line, idx) => {
    if (isCommentLine(line)) return;
    const lineNo = idx + 1;
    hits.push(...jsxLeftovers(line, lineNo));
    hits.push(...propLeftovers(line, lineNo, isTs));
  });
  hits.push(...templatePropLeftovers(src));
  return hits;
};

/** The file's path relative to src/, the form the allowlist keys use. */
export const relFromSrc = (file: string): string => file.slice("src/".length);

/** Whether one source module ends in .ts rather than .tsx. */
export const isTsModule = (file: string): boolean => file.endsWith(".ts");

/** Whether the i18n rule applies to this file: a template module, or one of
 * the copy-bearing form modules outside the template tree. */
export const isI18nScanTarget = (file: string): boolean =>
  (file.startsWith(`${TEMPLATES_DIR}/`) &&
    (file.endsWith(".ts") || file.endsWith(".tsx"))) ||
  EXTRA_SCAN_FILES.includes(file);

/** The hard-coded strings a file may still carry under the ratchet. */
export const leftoverBudget = (file: string): number =>
  LEFTOVER_ALLOWLIST.get(relFromSrc(file)) ?? 0;
