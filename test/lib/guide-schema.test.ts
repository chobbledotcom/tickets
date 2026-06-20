import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unique } from "#fp";
import en from "#locales/en/index.ts";
import type { GuideSection } from "#templates/admin/guide/components.tsx";
import { guideSections } from "#templates/admin/guide.tsx";

/**
 * The admin guide is authored as data (a flat list of sections, each with a
 * flat list of entries) and holds no inline copy — every heading and question
 * is a locale id. These tests enforce the invariants that make that schema
 * trustworthy, so authoring mistakes fail here instead of shipping a broken
 * page:
 *   - every section heading resolves to a guide.sections.<titleKey> string;
 *   - every entry's question resolves to guide.q.<id>, and every data-driven
 *     faq entry's answer to guide.a.<id> (a typo would otherwise render the raw
 *     id in place of the heading/question/answer);
 *   - section anchor ids are unique (duplicates break the #anchor deep-links
 *     other admin pages use, e.g. /admin/guide#modifiers);
 *   - every section is non-empty (a heading with no entries is dead markup).
 *
 * `builderEnabled` is set so the conditionally-included Built Sites section is
 * covered too.
 */
const messages = en as Record<string, string>;

const allSections = (): GuideSection[] =>
  guideSections({
    builderEnabled: true,
    bunnyDnsSubdomainSuffix: ".example.com",
    hostAppleWalletPassTypeId: null,
    hostEmailFromAddress: null,
    hostEmailProvider: null,
    hostGoogleWalletIssuerId: null,
  });

describe("guide schema", () => {
  test("every heading, question and answer resolves to a locale key", () => {
    const missing: string[] = [];
    const require = (key: string): void => {
      if (!(key in messages)) missing.push(key);
    };

    for (const section of allSections()) {
      require(`guide.sections.${section.titleKey}`);
      for (const entry of section.entries) {
        if ("faq" in entry) {
          require(`guide.q.${entry.faq}`);
          require(`guide.a.${entry.faq}`);
        } else {
          require(`guide.q.${entry.custom}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("section anchor ids are unique", () => {
    const ids = allSections()
      .map((section) => section.id)
      .filter((id): id is string => id !== undefined);

    expect(ids).toEqual(unique(ids));
  });

  test("every section has at least one entry", () => {
    const empty = allSections().filter(
      (section) => section.entries.length === 0,
    );

    expect(empty).toEqual([]);
  });
});
