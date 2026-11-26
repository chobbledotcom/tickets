import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { t } from "#i18n";
import {
  SCANNER_WORDS,
  type ScannerWords,
  ScannerWordsSchema,
} from "#shared/scanner-words.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

/** The words whose catalog key does not follow the naming rule. */
const KEY_EXCEPTIONS: Partial<Record<keyof ScannerWords, string>> = {
  checkInButton: "admin.scanner.check_in",
};

/** The catalog key a word must carry: its name in snake case under
 * `admin.scanner.`, unless it is a listed exception. The rule is written
 * here, apart from the table the template reads, so a key swapped between
 * two words with the same holes fails. */
const expectedKey = (word: keyof ScannerWords): string =>
  KEY_EXCEPTIONS[word] ??
  `admin.scanner.${word.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`;

/** The words one rendered page sends its browser code. */
const pageWords = (html: string) => {
  const attribute = html.match(/data-words="([^"]*)"/)?.[1];
  if (attribute === undefined) throw new Error("The page sends no words.");
  return v.parse(
    ScannerWordsSchema,
    JSON.parse(attribute.replaceAll("&quot;", '"').replaceAll("&amp;", "&")),
  );
};

describe("the scanner page's words", () => {
  beforeAll(setupAdminPageTest);

  test("sends every word once, each the catalog's words with its holes left open", () => {
    const html = adminScannerPage(
      { name: "Doors" },
      {
        cache: "/admin/groups/5/scan-cache",
        scan: "/admin/groups/5/scan",
        search: "/admin/groups/5/scan-search",
      },
      OWNER_SESSION,
      false,
      "test-door-cache-key",
      7,
    );
    expect(html.split("data-words=").length - 1).toBe(1);
    const words = pageWords(html);
    for (const [name, { holes }] of Object.entries(SCANNER_WORDS)) {
      const word = name as keyof ScannerWords;
      const open = Object.fromEntries(holes.map((hole) => [hole, `{${hole}}`]));
      expect(SCANNER_WORDS[word].key, word).toBe(expectedKey(word));
      expect(words[word], word).toBe(t(expectedKey(word), open));
    }
    // The client reads its CSRF token from this meta; without it every scan
    // POST fails the token check.
    assertStringIncludes(html, '<meta name="csrf-token"');
  });
});
