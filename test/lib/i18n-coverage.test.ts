import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import en from "#locales/en/index.ts";

/**
 * Codebase-level i18n coverage, verified in both directions:
 *   forward  — every t("key") reference in the source resolves to a real
 *              locale key (no typos / dangling references);
 *   backward — no user-facing string is left hard-coded in a scanned source
 *              file (everything goes through t()), except a budget of strings
 *              still pending wiring, recorded per file in LEFTOVER_ALLOWLIST.
 *
 * The backward scan covers JSX templates (.tsx) AND the .ts modules that hold
 * field/copy definitions (e.g. fields.ts, email/defaults.ts) plus the shared
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

const messages = en as Record<string, string>;

const SRC_DIR = "src";
const TEMPLATES_DIR = "src/ui/templates";

/** Copy-bearing modules outside src/ui/templates that must also be kept honest:
 * the shared form framework renders its own labels and submit buttons. */
const EXTRA_SCAN_FILES = ["src/shared/forms.tsx"];

/** Files (relative to src/) with hard-coded user-facing strings still pending
 * i18n wiring, mapped to the exact number of leftover literals each still has.
 * Wire a file's strings with t(), then lower its number — or delete the entry
 * once it reaches zero. The number may never go up. */
const LEFTOVER_ALLOWLIST = new Map<string, number>([
  ["shared/forms.tsx", 5],
  ["ui/templates/admin/api-keys.tsx", 3],
  ["ui/templates/admin/attendee-form.tsx", 17],
  ["ui/templates/admin/attendees.tsx", 10],
  ["ui/templates/admin/calendar.tsx", 1],
  ["ui/templates/admin/database-reset.tsx", 1],
  ["ui/templates/admin/debug.tsx", 6],
  ["ui/templates/admin/guide.tsx", 1],
  ["ui/templates/admin/guide/accounts.tsx", 1],
  ["ui/templates/admin/guide/components.tsx", 3],
  ["ui/templates/admin/guide/domains.tsx", 2],
  ["ui/templates/admin/guide/email.tsx", 8],
  ["ui/templates/admin/guide/integrations.tsx", 7],
  ["ui/templates/admin/guide/operations.tsx", 3],
  ["ui/templates/admin/guide/payments.tsx", 3],
  ["ui/templates/admin/guide/tickets.tsx", 16],
  ["ui/templates/admin/listings.tsx", 1],
  ["ui/templates/admin/questions.tsx", 4],
  ["ui/templates/admin/sessions.tsx", 1],
  ["ui/templates/admin/settings/apple-wallet.tsx", 2],
  ["ui/templates/admin/settings/business-email.tsx", 1],
  ["ui/templates/admin/settings/custom-domain.tsx", 5],
  ["ui/templates/admin/settings/email-tpl-confirmation.tsx", 11],
  ["ui/templates/admin/settings/email.tsx", 1],
  ["ui/templates/admin/settings/embed-hosts.tsx", 1],
  ["ui/templates/admin/settings/google-wallet.tsx", 2],
  ["ui/templates/admin/settings/payment.tsx", 10],
  ["ui/templates/admin/settings/public-api.tsx", 1],
  ["ui/templates/admin/site.tsx", 2],
  ["ui/templates/email/defaults.ts", 12],
  ["ui/templates/fields.ts", 46],
  ["ui/templates/public/shared.tsx", 2],
]);

/** t("key") / t('key') / t(`key`) not preceded by an identifier char. */
const T_CALL = /(?<![A-Za-z0-9_$])t\(\s*(["'`])([^"'`]+)\1/g;

/** Hard-coded user-facing JSX attribute values. */
const ATTR =
  /\b(placeholder|title|aria-label|alt|label)\s*=\s*(["'])([^"'{][^"']*)\2/g;
/** Hard-coded user-facing object-property values (field definitions in .ts
 * modules build labels/placeholders/hints as object properties, not JSX). */
const PROP =
  /\b(placeholder|title|label|hint|hintHtml|legend|summary|description)\s*:\s*(["'])([^"'{][^"']*)\2/g;
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
const wordy = (s: string): boolean => /[a-z]/.test(s);

const walk = (dir: string, exts: string[]): string[] => {
  const out: string[] = [];
  const recurse = (d: string) => {
    for (const e of Deno.readDirSync(d)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) recurse(p);
      else if (exts.some((x) => p.endsWith(x))) out.push(p);
    }
  };
  recurse(dir);
  return out;
};

/** The files the backward scan covers: every .ts/.tsx under templates plus the
 * explicit extra copy-bearing modules. */
const scanTargets = (): string[] => [
  ...walk(TEMPLATES_DIR, [".ts", ".tsx"]),
  ...EXTRA_SCAN_FILES,
];

const relFromSrc = (file: string): string => file.slice(SRC_DIR.length + 1);

/** Object-property labels are a .ts-module idiom; .tsx uses JSX instead. */
const isTsModule = (file: string): boolean => file.endsWith(".ts");

/** Hard-coded user-facing strings still present in a file's source. */
const leftoverLiterals = (src: string, isTs: boolean): string[] => {
  const hits: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const m of line.matchAll(ATTR)) {
      const value = m[3] ?? "";
      if (wordy(value)) hits.push(`L${i + 1} ${m[1]}="${value}"`);
    }
    if (isTs) {
      for (const m of line.matchAll(PROP)) {
        const value = m[3] ?? "";
        if (wordy(value)) hits.push(`L${i + 1} ${m[1]}: "${value}"`);
      }
    }
    for (const m of line.matchAll(TEXT)) {
      const text = (m[1] ?? "").trim();
      if (wordy(text)) hits.push(`L${i + 1} text "${text}"`);
    }
  });
  return hits;
};

describe("i18n coverage", () => {
  test('forward: every t("key") in the source resolves to a locale key', () => {
    const missing: string[] = [];
    for (const file of walk(SRC_DIR, [".ts", ".tsx"])) {
      const src = Deno.readTextFileSync(file);
      for (const m of src.matchAll(T_CALL)) {
        const key = m[2]!;
        if (key.includes("${") || key.includes("{")) continue; // dynamic key
        if (!(key in messages)) missing.push(`${file}: t("${key}")`);
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
