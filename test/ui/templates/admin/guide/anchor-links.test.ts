import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { GuideSection } from "#templates/admin/guide/components.tsx";
import { guideSections } from "#templates/admin/guide.tsx";
import { walkSourceFiles } from "#test-utils/walk-src.ts";

/**
 * Every `/admin/guide#<anchor>` deep-link in the source must point at a real
 * guide section id. A page footer or inline link to a section that doesn't
 * exist scrolls to nothing, so this catches broken anchors at authoring time
 * instead of shipping a dead link — the same way `guide-schema.test.ts` keeps
 * the section ids unique.
 *
 * PENDING_SECTIONS are anchors whose guide section is planned but not yet
 * written. Their links are allowed to dangle until the section lands; delete
 * an entry here as soon as its section is authored (the second test fails if
 * you forget).
 */
const PENDING_SECTIONS = new Set<string>([]);

const SRC_DIR = "src";
const ANCHOR = /\/admin\/guide#([a-z0-9-]+)/g;

/** Every section id the guide renders (Built Sites included via builderEnabled),
 * matching the fixture `guide-schema.test.ts` uses. */
const sectionIds = (): Set<string> =>
  new Set(
    guideSections({
      builderEnabled: true,
      bunnyDnsSubdomainSuffix: ".example.com",
      hostAppleWalletPassTypeId: null,
      hostEmailFromAddress: null,
      hostEmailProvider: null,
      hostGoogleWalletIssuerId: null,
    })
      .map((section: GuideSection) => section.id)
      .filter((id): id is string => id !== undefined),
  );

describe("guide anchor links", () => {
  test("every /admin/guide#anchor resolves to a real section (or a pending one)", () => {
    const ids = sectionIds();
    const broken: string[] = [];
    for (const file of walkSourceFiles(SRC_DIR, [".ts", ".tsx", ".json"])) {
      const src = Deno.readTextFileSync(file);
      for (const m of src.matchAll(ANCHOR)) {
        const anchor = m[1]!;
        if (!ids.has(anchor) && !PENDING_SECTIONS.has(anchor)) {
          broken.push(`${file}: #${anchor}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("PENDING_SECTIONS has no stale entry (its section now exists)", () => {
    const ids = sectionIds();
    const stale = [...PENDING_SECTIONS].filter((anchor) => ids.has(anchor));
    expect(stale).toEqual([]);
  });
});
