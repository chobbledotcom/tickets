import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import { allEnglishMessages } from "#test-utils/i18n.ts";
import { walkSourceFiles as walk } from "#test-utils/walk-src.ts";

/**
 * Codebase-level i18n coverage, verified in both directions:
 *   forward  — every t("key") reference in the source resolves to a real
 *              locale key (no typos / dangling references);
 *   backward — no user-facing string is left hard-coded in a scanned source
 *              file (everything goes through t()), except a budget of strings
 *              still pending wiring, recorded per file in LEFTOVER_ALLOWLIST.
 *
 * The backward scan covers JSX templates (.tsx) AND the .ts modules that hold
 * field/copy definitions (e.g. fields/*.ts, email/defaults.ts) plus the shared
 * form framework — places where hard-coded labels used to slip through because
 * the scan only looked at .tsx text/attributes.
 *
 * LEFTOVER_ALLOWLIST is a ratchet, not a free pass: it records the EXACT number
 * of hard-coded strings each unfinished file still has. The backward test fails
 * if a file grows past its number (so a migrated file can never gain new
 * hard-coded copy), and the stale test fails if a file drops below its number
 * (lower it to lock in the progress) or reaches zero (remove the entry). The
 * debt can therefore only shrink, and every change to it shows up as a diff
 * here for review.
 */

const messages = await allEnglishMessages();

const SRC_DIR = "src";
const TEMPLATES_DIR = "src/ui/templates";

/** Copy-bearing modules outside src/ui/templates that must also be kept honest:
 * the shared form framework renders its own labels and submit buttons. */
const EXTRA_SCAN_FILES = [
  "src/shared/forms/message-fields.tsx",
  "src/shared/forms/rendering.tsx",
  "src/shared/forms/submitted-value.ts",
  "src/shared/forms/validation.ts",
];

/** Existing catalog copy that review found duplicated as wrapped JSX prose.
 * Requiring the catalog calls directly avoids depending on line layout or
 * inline markup such as <strong> and <kbd>. */
const REQUIRED_TEMPLATE_KEYS = new Map<string, readonly string[]>([
  [
    "src/ui/templates/setup.tsx",
    [
      "setup.agreement.controller_text",
      "setup.agreement.processor_text",
      "setup.agreement.encrypted_text",
      "setup.agreement.responsibilities_text",
      "setup.agreement.breach_text",
      "setup.agreement.deletion_text",
      "setup.agreement.password_warning",
    ],
  ],
  ["src/ui/templates/admin/guide.tsx", ["guide.search_hint"]],
]);

/** Files (relative to src/) with hard-coded user-facing strings still pending
 * i18n wiring, mapped to the exact number of leftover literals each still has.
 * Wire a file's strings with t(), then lower its number — or delete the entry
 * once it reaches zero. The number may never go up. */
const LEFTOVER_ALLOWLIST = new Map<string, number>([
  ["shared/forms/message-fields.tsx", 1],
  ["shared/forms/rendering.tsx", 4],
  ["ui/templates/admin/api-keys.tsx", 2],
  ["ui/templates/admin/calendar.tsx", 1],
  ["ui/templates/admin/guide/accounts.tsx", 1],
  ["ui/templates/admin/guide/domains.tsx", 2],
  ["ui/templates/admin/guide/email.tsx", 8],
  ["ui/templates/admin/guide/integrations.tsx", 6],
  ["ui/templates/admin/guide/payments.tsx", 2],
  ["ui/templates/admin/guide/tickets.tsx", 11],
  ["ui/templates/admin/listings/form-values.tsx", 1],
  ["ui/templates/admin/questions.tsx", 2],
  ["ui/templates/admin/sessions.tsx", 1],
  ["ui/templates/admin/settings/apple-wallet.tsx", 1],
  ["ui/templates/admin/settings/custom-domain.tsx", 5],
  ["ui/templates/admin/settings/email.tsx", 1],
  ["ui/templates/admin/settings/google-wallet.tsx", 1],
  ["ui/templates/admin/settings/payment.tsx", 8],
  ["ui/templates/admin/site.tsx", 2],
  ["ui/templates/email/defaults.ts", 12],
  ["ui/templates/fields/add-attendee.ts", 3],
  ["ui/templates/fields/listing.ts", 4],
  ["ui/templates/fields/modifier.ts", 20],
  ["ui/templates/fields/ticket.ts", 5],
]);

/** t("key") / t('key') / t(`key`) not preceded by an identifier char. */
const T_CALL = /(?<![A-Za-z0-9_$])t\(\s*(["'`])([^"'`]+)\1/g;

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

/** Comment lines never render to users, so strings in them aren't leftovers. */
const isCommentLine = (line: string): boolean => {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

/** Prose needing translation has a lowercase letter; bare numbers/symbols
 * (placeholder="0", "ID", "£") are locale-independent and don't count. */
const wordy = (s: string): boolean =>
  /[a-z]/.test(s.replaceAll(/\$\{[^}]*\}/g, ""));

/** The files the backward scan covers: every .ts/.tsx under templates plus the
 * explicit extra copy-bearing modules. */
const scanTargets = (): string[] => [
  ...walk(TEMPLATES_DIR, [".ts", ".tsx"]),
  ...EXTRA_SCAN_FILES,
];

const relFromSrc = (file: string): string => file.slice(SRC_DIR.length + 1);

const isTsModule = (file: string): boolean => file.endsWith(".ts");

const missingMessageReferences = (file: string): string[] => {
  const missing: string[] = [];
  const src = Deno.readTextFileSync(file);
  for (const match of src.matchAll(T_CALL)) {
    const key = match[2]!;
    if (key.includes("${") || key.includes("{")) continue;
    if (!(key in messages)) missing.push(`${file}: t("${key}")`);
  }
  return missing;
};

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
    const value = m[valueGroup] ?? "";
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
const leftoverLiterals = (src: string, isTs: boolean): string[] => {
  const hits: string[] = [];
  src.split("\n").forEach((line, idx) => {
    if (isCommentLine(line)) return;
    const lineNo = idx + 1;
    hits.push(...jsxLeftovers(line, lineNo));
    hits.push(...propLeftovers(line, lineNo, isTs));
  });
  return hits;
};

describe("i18n coverage", () => {
  test("object copy properties are scanned in TS and TSX without false positives", () => {
    const dollar = String.fromCodePoint(36);
    const nameExpression = `${dollar}{name}`;
    const translationExpression = `${dollar}{t("common.name")}`;
    expect(
      leftoverLiterals(
        'const table = { header: "Name", empty: "No rows", emptyText: `No results` };',
        false,
      ),
    ).toEqual([
      'L1 header: "Name"',
      'L1 empty: "No rows"',
      'L1 emptyText: "No results"',
    ]);
    expect(
      leftoverLiterals(
        'const field = { label: "Name", header: "Value" };',
        true,
      ),
    ).toEqual(['L1 label: "Name"', 'L1 header: "Value"']);
    expect(
      leftoverLiterals(
        `const table = { header: \`Keep (${nameExpression})\` };`,
        false,
      ),
    ).toEqual([`L1 header: "Keep (${nameExpression})"`]);
    expect(
      leftoverLiterals(
        `const table = { header: t("common.name"), empty: "", emptyText: \`${translationExpression}: ${nameExpression}\` };`,
        false,
      ),
    ).toEqual([]);
  });

  test("the manifest owns every English catalog", () => {
    const files = Array.from(Deno.readDirSync("src/locales/en"))
      .filter((entry) => entry.isFile && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort();

    expect(files).toEqual([...MESSAGE_GROUPS].sort());
  });

  test('forward: every t("key") in the source resolves to a locale key', () => {
    const missing = walk(SRC_DIR, [".ts", ".tsx"]).flatMap(
      missingMessageReferences,
    );
    expect(missing).toEqual([]);
  });

  test("reviewed template prose stays catalog-backed", () => {
    const missing: string[] = [];
    for (const [file, requiredKeys] of REQUIRED_TEMPLATE_KEYS) {
      const referencedKeys = new Set(
        Array.from(
          Deno.readTextFileSync(file).matchAll(T_CALL),
          (match) => match[2],
        ),
      );
      for (const key of requiredKeys) {
        if (!referencedKeys.has(key)) missing.push(`${file}: t("${key}")`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("backward: no hard-coded user-facing strings beyond each file's budget", () => {
    const offenders: string[] = [];
    for (const file of scanTargets()) {
      const rel = relFromSrc(file);
      const allowed = LEFTOVER_ALLOWLIST.get(rel) ?? 0;
      const hits = leftoverLiterals(
        Deno.readTextFileSync(file),
        isTsModule(file),
      );
      if (hits.length > allowed) {
        offenders.push(
          `${rel}: ${hits.length} hard-coded (budget ${allowed}) — wire with ` +
            "t(), or bump its allowlist count if still mid-migration: " +
            hits.slice(0, 3).join("; "),
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the leftover allowlist ratchets down (no stale or inflated entries)", () => {
    const stale: string[] = [];
    for (const [rel, allowed] of LEFTOVER_ALLOWLIST) {
      const path = `${SRC_DIR}/${rel}`;
      const src = (() => {
        try {
          return Deno.readTextFileSync(path);
        } catch {
          return null;
        }
      })();
      if (src === null) {
        stale.push(`${rel} (missing — remove from allowlist)`);
        continue;
      }
      const count = leftoverLiterals(src, isTsModule(path)).length;
      if (count === 0) stale.push(`${rel} (now clean — remove from allowlist)`);
      else if (count < allowed) {
        stale.push(`${rel} (down to ${count} — lower its allowlist count)`);
      }
    }
    expect(stale).toEqual([]);
  });
});
