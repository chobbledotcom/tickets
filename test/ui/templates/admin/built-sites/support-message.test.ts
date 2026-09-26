import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  runWithSavedFormContext,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import type { SupportMessageResult } from "#shared/site-support-message.ts";
import { SupportMessagePanel } from "#templates/admin/built-sites/support-message.tsx";
import { withEnv } from "#test-utils/env.ts";

const site: BuiltSite = {
  assignable: false,
  assignedAttendeeId: null,
  assignedListingId: null,
  created: "2026-01-01T00:00:00Z",
  dbProvider: "bunny",
  dbToken: "tok",
  dbUrl: "libsql://db",
  hostingId: "6200",
  hostingProvider: "bunny",
  id: 1,
  name: "Panel Site",
  readOnlyFrom: "",
  renewalToken: null,
  renewalTokenIndex: null,
  scheduledTaskKey: null,
  siteDataRevision: 1,
  siteUrl: "https://panel-site.b-cdn.net",
  updates: "release",
};

/** The panel's HTML for one read outcome. */
const panelHtml = (state: SupportMessageResult): string =>
  String(SupportMessagePanel({ site, state }));

/** The text held inside the panel's editor textarea. */
const editorContent = (html: string): string => {
  const start = html.indexOf(">", html.indexOf("<textarea")) + 1;
  return html.slice(start, html.indexOf("</textarea>"));
};

describe("SupportMessagePanel", () => {
  test("shows the Markdown editor holding the current value", () => {
    const html = panelHtml({ ok: true, value: "# Ring us" });
    expect(html).toContain('class="prose"');
    expect(html).toContain('action="/admin/built-sites/1/support-message"');
    expect(html).toContain('name="support_message"');
    expect(html).toContain("data-markdown-preview");
    // The stored limit is UTF-8 bytes, which a character maxlength cannot
    // express, so the panel states it instead.
    expect(html).toContain("at most 2,048 bytes");
    expect(html).toContain('class="hint"');
    expect(editorContent(html)).toBe("# Ring us");
    expect(html).toContain("Save support message");
  });

  test("shows an empty editor when no value is set", () => {
    const html = panelHtml({ ok: true, value: null });
    expect(html).toContain('name="support_message"');
    expect(editorContent(html)).toBe("");
  });

  test("shows the read failure instead of the editor", () => {
    const html = panelHtml({
      error: "Read support message failed (401): Authentication is required.",
      ok: false,
    });
    expect(html).toContain("The support message could not be read");
    expect(html).not.toContain('name="support_message"');
  });
  test("keeps a refused save's draft beside the read failure", () => {
    const html = runWithSavedFormContext(() => {
      setSavedFormData(
        new FormParams("support_message=%23+Draft+kept+through+the+outage"),
      );
      return panelHtml({
        error: "Read support message failed (500): outage",
        ok: false,
      });
    });
    expect(html).toContain("The support message could not be read");
    expect(html).toContain('name="support_message"');
    expect(editorContent(html)).toBe("# Draft kept through the outage");
  });

  test("keeps a cleared draft, not the stored message, after a refused save", () => {
    const html = runWithSavedFormContext(() => {
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
    expect(html).toContain("<h1>Quiet hours</h1>");
    expect(html).not.toContain('name="support_message"');
  });
});
