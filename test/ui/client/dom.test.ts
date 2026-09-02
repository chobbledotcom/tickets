// test-groups: run-alone
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { createButton, forEachMatch } from "#src/ui/client/dom.ts";
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
