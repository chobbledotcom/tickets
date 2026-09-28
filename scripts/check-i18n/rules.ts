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
/** Table configs are object properties in both .ts and .tsx. Template strings
 * are included because a header often contains a row or attendee name. */
const TABLE_PROP =
  /\b(header|empty|emptyText)\s*:\s*(["'`])([^"'`{][^"'`]*)\2/g;
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
  ["ui/templates/admin/guide/accounts.tsx", 1],
  ["ui/templates/admin/guide/email.tsx", 6],
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

/** Wordy matches of `re` on one line, each formatted via `label`. The captured
 * user-facing value lives in group `valueGroup` (differs per pattern). */
const matchesOnLine = (
  line: string,
  lineNo: number,
  re: RegExp,
  valueGroup: number,
  label: (m: RegExpMatchArray, value: string, lineNo: number) => string,
): string[] => {
  const out: string[] = [];
  for (const m of line.matchAll(re)) {
    // Every caller's regex captures `valueGroup` in every match.
    const value = m[valueGroup]!;
    if (wordy(value)) out.push(label(m, value, lineNo));
  }
  return out;
};

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

/** Hard-coded strings in object-property definitions on one line. TS copy
 * modules use the full set; TSX adds table configs to its JSX scan. */
const propLeftovers = (line: string, lineNo: number, isTs: boolean): string[] =>
  matchesOnLine(
    line,
    lineNo,
    isTs ? PROP : TABLE_PROP,
    3,
    (m, v, n) => `L${n} ${m[1]}: "${v}"`,
  );

/** Hard-coded user-facing strings still present in a file's source. */
export const leftoverLiterals = (src: string, isTs: boolean): string[] => {
  const hits: string[] = [];
  src.split("\n").forEach((line, idx) => {
    if (isCommentLine(line)) return;
    const lineNo = idx + 1;
    hits.push(...jsxLeftovers(line, lineNo));
    hits.push(...propLeftovers(line, lineNo, isTs));
  });
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
