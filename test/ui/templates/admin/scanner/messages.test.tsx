import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { escapeHtml } from "#jsx/escape-html.ts";
import { relativeToProject } from "#scripts/path.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

/** The camera page renders the scanner client its words as `data-message-*`
 * attributes, and the client's own fallback copy must stay those same words:
 * a lookup that misses has to say what the page would have said. The pairs
 * here are read out of the client's source, so a message the client starts
 * reading without a matching attribute fails this test instead of showing
 * the fallback copy at a door. */
const clientMessages = (source: string): [string, string][] =>
  [
    ...source.matchAll(
      /(?:getMessage|nameAndTicketsMessage|askConfirm)\(\s*messages\s*,\s*["'](\w+)["']\s*,\s*(["'])((?:\\.|(?!\2).)*)\2/g,
    ),
  ].map(([, key, , fallback]) => [key, fallback] as [string, string]);

describe("the scanner page's words", () => {
  beforeAll(setupAdminPageTest);

  test("carries every message the client reads, in the client's own words", async () => {
    const source = await Deno.readTextFile(
      relativeToProject("src/ui/client/scanner.js"),
    );
    const messages = clientMessages(source);
    // One message per key the client reads today. A change here means the
    // client started or stopped reading a message: re-check the page
    // carries it, then update this count.
    expect(messages.length).toBe(16);
    const html = adminScannerPage(
      { name: "Doors" },
      "/admin/groups/5/scan",
      OWNER_SESSION,
      [],
      false,
      "test-door-cache-key",
      7,
    );
    for (const [key, fallback] of messages) {
      assertStringIncludes(
        html,
        `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${escapeHtml(
          fallback,
        )}"`,
        `data message for ${key}`,
      );
    }
    // The client reads its CSRF token from this meta; without it every scan
    // POST fails the token check.
    assertStringIncludes(html, '<meta name="csrf-token"');
  });
});
