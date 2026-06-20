import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unique } from "#fp";
import en from "#locales/en/index.ts";
import type {
  GuideEntry,
  GuideSection,
} from "#templates/admin/guide/components.tsx";
import { guideSections } from "#templates/admin/guide.tsx";

/**
 * The admin guide is authored as data (a flat list of sections, each with a
 * flat list of entries) rather than hand-nested JSX. These tests enforce the
 * invariants that make that schema trustworthy, so authoring mistakes fail here
 * instead of shipping a broken page:
 *   - every data-driven FAQ id resolves to a real question/answer locale key
 *     (a typo would otherwise render the raw id as the question text);
 *   - section anchor ids are unique (duplicates break the #anchor deep-links
 *     that other admin pages use, e.g. /admin/guide#modifiers);
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

const allEntries = (): GuideEntry[] =>
  allSections().flatMap((section) => section.entries);

describe("guide schema", () => {
  test("every FAQ id resolves to a question and answer locale key", () => {
    const missing: string[] = [];
    for (const entry of allEntries()) {
      if (!("faq" in entry)) continue;
      if (!(`guide.q.${entry.faq}` in messages)) {
        missing.push(`guide.q.${entry.faq}`);
      }
      if (!(`guide.a.${entry.faq}` in messages)) {
        missing.push(`guide.a.${entry.faq}`);
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

  test("every custom entry has a non-empty question", () => {
    const blank = allEntries().filter(
      (entry) => "question" in entry && entry.question.trim() === "",
    );

    expect(blank).toEqual([]);
  });

  test("every section has a title and at least one entry", () => {
    const empty = allSections().filter(
      (section) => section.title.trim() === "" || section.entries.length === 0,
    );

    expect(empty).toEqual([]);
  });
});
