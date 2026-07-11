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

  test("reuses the admin bundle's cache-busting query", () => {
    const window = installDom(
      '<script src="/admin.js?ts=1234"></script><textarea data-markdown-preview></textarea>',
    );
    initMarkdownEditorLoader();
    expect(
      window.document.head.querySelector("script[defer]")?.getAttribute("src"),
    ).toBe("/markdown-editor.js?ts=1234");
  });

  test("adds no query when the admin bundle has none", () => {
    const window = installDom(
      '<script src="/admin.js"></script><textarea data-markdown-preview></textarea>',
    );
    initMarkdownEditorLoader();
    expect(
      window.document.head.querySelector("script[defer]")?.getAttribute("src"),
    ).toBe("/markdown-editor.js");
  });

  test("loads the editor beside an absolute CDN admin bundle", () => {
    const window = installDom(
      '<script src="/unrelated.js"></script><script src="https://assets.example.com/assets/release/admin.js"></script><textarea data-markdown-preview></textarea>',
    );
    initMarkdownEditorLoader();
    expect(
      window.document.head.querySelector("script[defer]")?.getAttribute("src"),
    ).toBe("https://assets.example.com/assets/release/markdown-editor.js");
  });

  test("does not load the bundle on pages without markdown fields", () => {
    const window = installDom("<textarea></textarea>");
    initMarkdownEditorLoader();
    expect(window.document.head.querySelector("script")).toBeNull();
  });
});
