import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unique } from "#fp";
import { GUIDE_MESSAGE_GROUPS } from "#locales/manifest.ts";
import type { GuideSection } from "#templates/admin/guide/components.tsx";
import { guideSections } from "#templates/admin/guide.tsx";
import { allEnglishMessages } from "#test-utils/i18n.ts";

const en = await allEnglishMessages(GUIDE_MESSAGE_GROUPS);

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
const allSections = (): GuideSection[] =>
  guideSections({
    builderEnabled: true,
    hostAppleWalletPassTypeId: null,
    hostEmailFromAddress: null,
    hostEmailProvider: null,
    hostGoogleWalletIssuerId: null,
  });

describe("guide schema", () => {
  test("every heading, question and answer resolves to a locale key", () => {
    const missing: string[] = [];
    const require = (key: string): void => {
      if (!(key in en)) missing.push(key);
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

  test("no catalog key is dead copy", () => {
    // The forward test above proves every entry has its keys. This one
    // proves the reverse: every guide.sections / guide.q / guide.a key in
    // the catalogs is reachable from the schema. A custom entry renders
    // its own JSX body, so a guide.a key beside one is copy nothing reads —
    // the class of dead answer keys that otherwise rot silently when an
    // entry switches to custom and leaves its old answer key behind.
    const sections = allSections();
    const entryIds = new Set(
      sections.flatMap((section) =>
        section.entries.map((entry) =>
          "faq" in entry ? entry.faq : entry.custom,
        ),
      ),
    );
    const faqIds = new Set(
      sections.flatMap((section) =>
        section.entries.flatMap((entry) => ("faq" in entry ? [entry.faq] : [])),
      ),
    );
    const titleKeys = new Set(sections.map((section) => section.titleKey));

    const dead = Object.keys(en).filter((key) => {
      if (key.startsWith("guide.sections.")) {
        return !titleKeys.has(key.slice("guide.sections.".length));
      }
      if (key.startsWith("guide.q.")) {
        return !entryIds.has(key.slice("guide.q.".length));
      }
      if (key.startsWith("guide.a.")) {
        return !faqIds.has(key.slice("guide.a.".length));
      }
      return false;
    });

    expect(dead).toEqual([]);
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
