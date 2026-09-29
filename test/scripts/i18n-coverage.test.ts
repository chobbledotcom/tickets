import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import {
  EXTRA_SCAN_FILES,
  isTsModule,
  LEFTOVER_ALLOWLIST,
  leftoverLiterals,
  relFromSrc,
  T_CALL,
  TEMPLATES_DIR,
} from "#scripts/check-i18n/rules.ts";
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
 * The per-string detection lives in scripts/check-i18n/rules.ts, which the
 * grader's i18n_catalog check shares. This file owns the tree-wide scans:
 * the catalog manifest, the forward key resolution, the reviewed prose that
 * must stay catalog-backed, the backward budget, and the allowlist ratchet.
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

/** The files the backward scan covers: every .ts/.tsx under templates plus the
 * explicit extra copy-bearing modules. */
const scanTargets = (): string[] => [
  ...walk(TEMPLATES_DIR, [".ts", ".tsx"]),
  ...EXTRA_SCAN_FILES,
];

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

describe("i18n coverage", () => {
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
