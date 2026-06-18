import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import en from "#locales/en/index.ts";

/**
 * Codebase-level i18n coverage, verified in both directions:
 *   forward  — every t("key") reference in the source resolves to a real
 *              locale key (no typos / dangling references);
 *   backward — no user-facing string is left hard-coded in a template
 *              (everything goes through t()), except the files still pending
 *              wiring, listed in LEFTOVER_ALLOWLIST below.
 *
 * As pages are wired, delete them from the allowlist — the "allowlist is not
 * stale" test fails until you do, so the list can only shrink.
 */

const messages = en as Record<string, string>;

const TEMPLATES_DIR = "src/ui/templates";

/** Templates that still contain hard-coded user-facing strings (paths relative
 * to src/ui/templates/). The remaining i18n wiring to tackle. */
const LEFTOVER_ALLOWLIST = new Set<string>([
  "admin/api-keys.tsx",
  "admin/attendee-form.tsx",
  "admin/attendees.tsx",
  "admin/calendar.tsx",
  "admin/database-reset.tsx",
  "admin/debug.tsx",
  "admin/guide.tsx",
  "admin/guide/accounts.tsx",
  "admin/guide/components.tsx",
  "admin/guide/domains.tsx",
  "admin/guide/email.tsx",
  "admin/guide/integrations.tsx",
  "admin/guide/operations.tsx",
  "admin/guide/payments.tsx",
  "admin/guide/tickets.tsx",
  "admin/listings.tsx",
  "admin/questions.tsx",
  "admin/scanner.tsx",
  "admin/sessions.tsx",
  "admin/settings/apple-wallet.tsx",
  "admin/settings/business-email.tsx",
  "admin/settings/custom-domain.tsx",
  "admin/settings/email-tpl-confirmation.tsx",
  "admin/settings/email.tsx",
  "admin/settings/embed-hosts.tsx",
  "admin/settings/google-wallet.tsx",
  "admin/settings/payment.tsx",
  "admin/settings/public-api.tsx",
  "admin/site.tsx",
  "public.tsx",
]);

/** t("key") / t('key') / t(`key`) not preceded by an identifier char. */
const T_CALL = /(?<![A-Za-z0-9_$])t\(\s*(["'`])([^"'`]+)\1/g;

/** Hard-coded user-facing attribute values. */
const ATTR =
  /\b(placeholder|title|aria-label|alt|label)\s*=\s*(["'])([^"'{][^"']*)\2/g;
/** JSX text node: capitalised words containing a lowercase letter ({expr}
 * children start with "{", not a letter, so are excluded). */
const TEXT = />\s*([A-Z][A-Za-z][A-Za-z ,.'!?&():-]{1,})\s*</g;

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

/** Hard-coded user-facing strings still present in a template's source. */
const leftoverLiterals = (src: string): string[] => {
  const hits: string[] = [];
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(ATTR))
      hits.push(`L${i + 1} ${m[1]}="${m[3]}"`);
    for (const m of line.matchAll(TEXT)) {
      const text = m[1] ?? "";
      if (/[a-z]/.test(text)) hits.push(`L${i + 1} text "${text.trim()}"`);
    }
  });
  return hits;
};

describe("i18n coverage", () => {
  test('forward: every t("key") in the source resolves to a locale key', () => {
    const missing: string[] = [];
    for (const file of walk("src", [".ts", ".tsx"])) {
      const src = Deno.readTextFileSync(file);
      for (const m of src.matchAll(T_CALL)) {
        const key = m[2]!;
        if (key.includes("${") || key.includes("{")) continue; // dynamic key
        if (!(key in messages)) missing.push(`${file}: t("${key}")`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("backward: templates have no hard-coded user-facing strings (except allowlisted)", () => {
    const offenders: string[] = [];
    for (const file of walk(TEMPLATES_DIR, [".tsx"])) {
      const rel = file.slice(TEMPLATES_DIR.length + 1);
      if (LEFTOVER_ALLOWLIST.has(rel)) continue;
      const hits = leftoverLiterals(Deno.readTextFileSync(file));
      if (hits.length) offenders.push(`${rel}: ${hits.slice(0, 3).join("; ")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the leftover allowlist has no stale entries (wired files must be removed)", () => {
    const stale: string[] = [];
    for (const rel of LEFTOVER_ALLOWLIST) {
      const path = `${TEMPLATES_DIR}/${rel}`;
      const src = (() => {
        try {
          return Deno.readTextFileSync(path);
        } catch {
          return null;
        }
      })();
      if (src === null) stale.push(`${rel} (missing — remove from allowlist)`);
      else if (leftoverLiterals(src).length === 0)
        stale.push(`${rel} (now clean — remove from allowlist)`);
    }
    expect(stale).toEqual([]);
  });
});
