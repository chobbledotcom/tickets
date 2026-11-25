import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { t } from "#i18n";
import { SCANNER_WORDS, ScannerWordsSchema } from "#shared/scanner-words.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

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
      "/admin/groups/5/scan",
      OWNER_SESSION,
      false,
      "test-door-cache-key",
      7,
    );
    expect(html.split("data-words=").length - 1).toBe(1);
    const words = pageWords(html);
    for (const [name, { holes, key }] of Object.entries(SCANNER_WORDS)) {
      const open = Object.fromEntries(holes.map((hole) => [hole, `{${hole}}`]));
      expect(words[name as keyof typeof words], name).toBe(t(key, open));
    }
    // The client reads its CSRF token from this meta; without it every scan
    // POST fails the token check.
    assertStringIncludes(html, '<meta name="csrf-token"');
  });
});
