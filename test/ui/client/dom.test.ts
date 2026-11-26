// test-groups: run-alone
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  cloneContent,
  createButton,
  createHiddenInput,
  createThumbnail,
  csrfTokenFor,
  forEachMatch,
  postJson,
  requiredAttribute,
  requiredChild,
  UnreadableAnswerError,
} from "#src/ui/client/dom.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

describe("client dom helpers", () => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());

  test("createButton and createHiddenInput make their elements", () => {
    dom.installDom("");
    const button = createButton("cart-add");
    const input = createHiddenInput("csrfToken", "page-token");
    expect([button.tagName, button.type, button.className]).toEqual([
      "BUTTON",
      "button",
      "cart-add",
    ]);
    expect([input.tagName, input.type, input.name, input.value]).toEqual([
      "INPUT",
      "hidden",
      "csrfToken",
      "page-token",
    ]);
  });

  test("createThumbnail makes a picture with its source, hint, and no alt text", () => {
    dom.installDom("");
    const lazy = createThumbnail("/image/one.webp", "lazy");
    expect(lazy.tagName).toBe("IMG");
    expect(lazy.getAttribute("alt")).toBe("");
    expect(lazy.loading).toBe("lazy");
    expect(lazy.getAttribute("src")).toBe("/image/one.webp");
    expect(createThumbnail("/image/two.webp", "eager").loading).toBe("eager");
  });

  test("cloneContent copies the whole subtree into a new node", () => {
    dom.installDom('<div id="source"><span>inner</span></div>');
    const source = requiredChild<HTMLElement>(document, "#source");
    const copy = cloneContent(source);
    expect(copy).not.toBe(source);
    expect(requiredChild(copy, "span").textContent).toBe("inner");
  });

  test("postJson posts the body with the CSRF header and reads the JSON answer", async () => {
    using _fetch = stubFetch((url, init) => {
      expect(url).toBe("/admin/scan");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "x-csrf-token": "csrf-token",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ token: "abc" });
      return Response.json({ status: "checked_in" });
    });

    expect(
      await postJson("/admin/scan", "csrf-token", { token: "abc" }),
    ).toEqual({ status: "checked_in" });
  });

  test("postJson refuses an answer that is not JSON", async () => {
    using _fetch = stubFetch(
      () =>
        new Response("<h1>Busy</h1>", {
          headers: { "content-type": "text/html" },
          status: 503,
        }),
    );

    await expect(
      postJson("/admin/scan", "csrf-token", { token: "abc" }),
    ).rejects.toThrow(
      new UnreadableAnswerError(
        "The request to /admin/scan answered 503 without JSON",
      ),
    );
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

  test("requiredAttribute answers the attribute's text, even when empty", () => {
    dom.installDom(
      '<div data-scan-path="/admin/listing/9/scan" data-empty=""></div>',
    );
    const div = requiredChild(document, "div");
    expect(requiredAttribute(div, "data-scan-path")).toBe(
      "/admin/listing/9/scan",
    );
    expect(requiredAttribute(div, "data-empty")).toBe("");
  });

  test("requiredAttribute names the attribute the element lacks", () => {
    dom.installDom("<div></div>");
    expect(() =>
      requiredAttribute(requiredChild(document, "div"), "data-scan-path"),
    ).toThrow("Missing attribute: data-scan-path");
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
