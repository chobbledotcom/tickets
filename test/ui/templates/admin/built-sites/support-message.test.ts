import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms/saved-data.ts";
import type { SupportMessageResult } from "#shared/site-support-message.ts";
import { SupportMessagePanel } from "#templates/admin/built-sites/support-message.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withEnv } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

const site: BuiltSite = testBuiltSite({
  dbToken: "tok",
  dbUrl: "libsql://db",
  hostingId: "6200",
  name: "Panel Site",
  siteDataRevision: 1,
  siteUrl: "https://panel-site.b-cdn.net",
});

/** The panel's HTML for one read outcome. */
const panelHtml = (state: SupportMessageResult): string =>
  String(SupportMessagePanel({ site, state }));

/** The text between the editor's textarea tags, before any parsing. */
const editorRaw = (html: string): string => {
  const start = html.indexOf(">", html.indexOf("<textarea")) + 1;
  return html.slice(start, html.indexOf("</textarea>"));
};

/** The text the browser holds in the editor: HTML parsing eats the first
 * newline after a `<textarea>` start tag, so the markup carries one spare
 * newline before the value. */
const editorContent = (html: string): string => {
  const raw = editorRaw(html);
  return raw.startsWith("\n") ? raw.slice(1) : raw;
};

describe("SupportMessagePanel", () => {
  test("shows the Markdown editor holding the current value", () => {
    const html = panelHtml({ ok: true, value: "# Ring us" });
    expectIncludesAll(html, [
      'class="prose"',
      'action="/admin/built-sites/1/support-message"',
      'name="support_message"',
      "data-markdown-preview",
      // The stored limit is UTF-8 bytes, which a character maxlength cannot
      // express, so the panel states it instead.
      "at most 2,048 bytes",
      'class="hint"',
    ]);
    expect(editorContent(html)).toBe("# Ring us");
    assertStringIncludes(html, "Save support message");
  });

  test("shows an empty editor when no value is set", () => {
    const html = panelHtml({ ok: true, value: null });
    assertStringIncludes(html, 'name="support_message"');
    expect(editorContent(html)).toBe("");
  });

  test("keeps a leading newline in the stored message", () => {
    const html = panelHtml({ ok: true, value: "\n# Ring us" });
    // One spare newline for the parser, then the value exactly as stored.
    expect(editorRaw(html)).toBe("\n\n# Ring us");
    expect(editorContent(html)).toBe("\n# Ring us");
  });

  test("shows the read failure instead of the editor", () => {
    const html = panelHtml({
      error: "Read support message failed (401): Authentication is required.",
      ok: false,
    });
    assertStringIncludes(html, "The support message could not be read");
    assert(!html.includes('name="support_message"'));
  });
  test("keeps a refused save's draft beside the read failure", async () => {
    const html = await withRequestContext(() => {
      setSavedFormData(
        new FormParams("support_message=%23+Draft+kept+through+the+outage"),
      );
      return panelHtml({
        error: "Read support message failed (500): outage",
        ok: false,
      });
    });
    expectIncludesAll(html, [
      "The support message could not be read",
      'name="support_message"',
    ]);
    expect(editorContent(html)).toBe("# Draft kept through the outage");
  });

  test("keeps a cleared draft, not the stored message, after a refused save", async () => {
    const html = await withRequestContext(() => {
      // The operator cleared the field and the save failed: the empty
      // choice is theirs, so the stored value must not resurface.
      setSavedFormData(new FormParams("support_message="));
      return panelHtml({ ok: true, value: "# Old message" });
    });
    expect(editorContent(html)).toBe("");
  });

  test("renders the message as Markdown with no form while read-only", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = panelHtml({ ok: true, value: "# Quiet hours" });
    assertStringIncludes(html, "<h1>Quiet hours</h1>");
    assert(!html.includes('name="support_message"'));
  });
});
