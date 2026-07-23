/**
 * The markdown-editor loader: on pages with a markdown textarea it injects
 * the editor bundle (deferred, reusing the admin bundle's cache-busting
 * query), and stays inert everywhere else.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initMarkdownEditorLoader } from "#src/ui/client/admin/markdown-editor-loader.ts";
import { cleanup, installDom } from "#test-utils/markdown-editor-dom.ts";

afterEach(cleanup);

describe("initMarkdownEditorLoader", () => {
  test("injects the editor bundle when the page has a markdown textarea", () => {
    const window = installDom("<textarea data-markdown-preview></textarea>");
    initMarkdownEditorLoader();
    const script = window.document.head.querySelector("script");
    expect(script?.getAttribute("src")).toBe("/markdown-editor.js");
    expect(script?.hasAttribute("defer")).toBe(true);
  });
});
