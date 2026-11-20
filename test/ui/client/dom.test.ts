// test-groups: run-alone
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  createButton,
  csrfTokenFor,
  forEachMatch,
  requiredChild,
} from "#src/ui/client/dom.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

describe("client dom helpers", () => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());

  test("createButton makes a type=button element with the given class", () => {
    dom.installDom("");
    const button = createButton("cart-add");
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.className).toBe("cart-add");
  });

  test("requiredChild answers the one element the selector names", () => {
    dom.installDom('<form><input name="name" value="Harbour"></form>');
    const form = requiredChild<HTMLFormElement>(document, "form");
    expect(requiredChild<HTMLInputElement>(form, "input").value).toBe(
      "Harbour",
    );
  });

  test("requiredChild names the selector that matched nothing", () => {
    dom.installDom("<form></form>");
    expect(() => requiredChild(document, "dialog")).toThrow(
      "Missing element: dialog",
    );
  });

  test("csrfTokenFor reads the token from the element's form", () => {
    dom.installDom(
      '<form><input name="csrfToken" value="page-token"><textarea></textarea></form>',
    );
    const textarea = requiredChild<HTMLTextAreaElement>(document, "textarea");
    expect(csrfTokenFor(textarea)).toBe("page-token");
  });

  test("csrfTokenFor answers empty without a form or a token field", () => {
    dom.installDom("<p>Loose</p><form></form>");
    expect(csrfTokenFor(requiredChild(document, "p"))).toBe("");
    expect(csrfTokenFor(requiredChild(document, "form"))).toBe("");
  });

  test("forEachMatch runs fn for every matching element, and no others", () => {
    dom.installDom(
      '<a class="x" href="/1"></a><a class="x" href="/2"></a>' +
        '<a class="y" href="/3"></a>',
    );
    const hrefs: string[] = [];
    forEachMatch<HTMLAnchorElement>("a.x", (link) =>
      hrefs.push(link.getAttribute("href") ?? ""),
    );
    expect(hrefs).toEqual(["/1", "/2"]);
  });
});
