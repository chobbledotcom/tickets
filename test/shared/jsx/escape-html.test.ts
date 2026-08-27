import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { escapeHtml } from "#jsx/escape-html.ts";

describe("escapeHtml", () => {
  test("escapes each character that is unsafe in markup", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
  });

  test("escapes the ampersand first, so an entity is not escaped twice", () => {
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  test("escapes every occurrence, not only the first", () => {
    expect(escapeHtml("a<b<c")).toBe("a&lt;b&lt;c");
  });

  test("takes a whole tag apart", () => {
    expect(escapeHtml('<a href="x">hi</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;hi&lt;/a&gt;",
    );
  });

  test("leaves text with nothing to escape as it was", () => {
    expect(escapeHtml("plain text 'quoted'")).toBe("plain text 'quoted'");
  });

  test("leaves an empty string empty", () => {
    expect(escapeHtml("")).toBe("");
  });
});
